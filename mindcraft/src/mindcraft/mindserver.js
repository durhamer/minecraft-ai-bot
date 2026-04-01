import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync, writeFileSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

const SETTINGS_PATH = path.join(__dirname, '../../settings.js');

function parseProfiles() {
    const content = readFileSync(SETTINGS_PATH, 'utf8');
    const match = content.match(/"profiles"\s*:\s*\[([\s\S]*?)\]/);
    if (!match) return [];
    const profiles = [];
    for (const line of match[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const commented = trimmed.startsWith('//');
        const pathMatch = trimmed.match(/"([^"]+\.json)"/);
        if (!pathMatch) continue;
        const profilePath = pathMatch[1];
        let name = profilePath, model = '';
        try {
            const json = JSON.parse(readFileSync(path.join(__dirname, '../../', profilePath), 'utf8'));
            name = json.name || profilePath;
            model = json.model || '';
        } catch (e) {}
        profiles.push({ path: profilePath, name, model, enabled: !commented });
    }
    return profiles;
}

function setProfileEnabled(profilePath, enable) {
    const escaped = profilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let content = readFileSync(SETTINGS_PATH, 'utf8');
    if (enable) {
        content = content.replace(new RegExp(`([ \\t]+)//[ \\t]*("${escaped}",?)`, 'g'), '$1$2');
    } else {
        content = content.replace(new RegExp(`([ \\t]+)("${escaped}",?)`, 'g'), '$1// $2');
    }
    writeFileSync(SETTINGS_PATH, content, 'utf8');
}

function deleteProfileFromSettings(profilePath) {
    const escaped = profilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let content = readFileSync(SETTINGS_PATH, 'utf8');
    content = content.replace(new RegExp(`[ \\t]*(?://[ \\t]*)?("${escaped}",?)[^\\n]*\\n`), '');
    writeFileSync(SETTINGS_PATH, content, 'utf8');
}

function addProfileToSettings(profilePath) {
    let content = readFileSync(SETTINGS_PATH, 'utf8');
    content = content.replace(
        /("profiles"\s*:\s*\[)([\s\S]*?)([ \t]*\],)/,
        (m, open, body, close) => `${open}${body}        "${profilePath}",\n    ${close}`
    );
    writeFileSync(SETTINGS_PATH, content, 'utf8');
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName].socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
				return
			}
			try {
				agent_connections[agentName].socket.emit('send-message', data)
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });

        // Launch all enabled profiles from settings.js
        socket.on('launch-profiles', async (callback) => {
            const base = mindcraft.getLaunchSettings();
            if (!base) { callback({ error: 'Base settings not available' }); return; }
            const profiles = parseProfiles().filter(p => p.enabled);
            if (profiles.length === 0) { callback({ error: 'No enabled profiles' }); return; }
            const results = [];
            for (const p of profiles) {
                try {
                    const profileJson = JSON.parse(readFileSync(path.join(__dirname, '../../', p.path), 'utf8'));
                    const s = { ...base, profile: profileJson };
                    const result = await mindcraft.createAgent(s);
                    results.push({ name: p.name, ...result });
                } catch (e) {
                    results.push({ name: p.name, success: false, error: e.message });
                }
            }
            agentsStatusUpdate();
            callback({ results });
        });

        // Persistent profile management (read/write settings.js)
        socket.on('get-profiles', (callback) => {
            try { callback({ profiles: parseProfiles() }); }
            catch (e) { callback({ error: e.message }); }
        });

        socket.on('set-profile-enabled', (profilePath, enabled, callback) => {
            try { setProfileEnabled(profilePath, enabled); callback({ success: true }); }
            catch (e) { callback({ error: e.message }); }
        });

        socket.on('delete-profile', (profilePath, callback) => {
            try { deleteProfileFromSettings(profilePath); callback({ success: true }); }
            catch (e) { callback({ error: e.message }); }
        });

        socket.on('get-profile-json', (profilePath, callback) => {
            try {
                const content = readFileSync(path.join(__dirname, '../../', profilePath), 'utf8');
                callback({ content });
            } catch (e) { callback({ error: e.message }); }
        });

        socket.on('save-profile-json', (profilePath, content, callback) => {
            try {
                JSON.parse(content);
                writeFileSync(path.join(__dirname, '../../', profilePath), content, 'utf8');
                callback({ success: true });
            } catch (e) { callback({ error: e.message }); }
        });

        socket.on('add-profile', (profilePath, jsonContent, callback) => {
            try {
                JSON.parse(jsonContent);
                writeFileSync(path.join(__dirname, '../../', profilePath), jsonContent, 'utf8');
                addProfileToSettings(profilePath);
                callback({ success: true });
            } catch (e) { callback({ error: e.message }); }
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;