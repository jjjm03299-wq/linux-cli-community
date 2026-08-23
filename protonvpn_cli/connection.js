// Standard Libraries & Configuration Imports
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const readline = require('readline');

// Project Constants & Utility Imports (Assuming equivalent module structure)
const { logger } = require('./logger');
const {
    checkInit,
    pullServerData,
    isConnected,
    getServers,
    getServerValue,
    getConfigValue,
    setConfigValue,
    getIpInfo,
    getCountryName,
    getFastestServer,
    checkUpdate,
    getDefaultNic,
    getTransferredData,
    createOpenVpnConfig,
    isIpv6Disabled,
    patchPassfile
} = require('./utils');

const {
    CONFIG_DIR,
    OVPN_FILE,
    PASSFILE,
    CONFIG_FILE
} = require('./constants');

/**
 * Connect to a random ProtonVPN Server.
 */
function randomC(protocol = null) {
    logger.debug("Starting random connect");
    if (!protocol) {
        protocol = getConfigValue("USER", "default_protocol");
    }
    const servers = getServers();
    const randomServer = servers[Math.floor(Math.random() * servers.length)];
    openvpnConnect(randomServer.Name, protocol);
}

/**
 * Connect to the fastest server available.
 */
function fastest(protocol = null) {
    logger.debug("Starting fastest connect");
    if (!protocol) {
        protocol = getConfigValue("USER", "default_protocol");
    }
    disconnect(true);
    pullServerData(true);
    const servers = getServers();
    const excludedFeatures = [1, 2]; // Secure-Core, Tor
    const serverPool = servers.filter(server => !excludedFeatures.includes(server.Features));
    const fastestServer = getFastestServer(serverPool);
    openvpnConnect(fastestServer, protocol);
}

/**
 * Connect to the fastest server in a specific country.
 */
function countryF(countryCode, protocol = null) {
    logger.debug("Starting fastest country connect");
    if (!protocol) {
        protocol = getConfigValue("USER", "default_protocol");
    }
    countryCode = countryCode.trim().toUpperCase();
    disconnect(true);
    pullServerData(true);
    const servers = getServers();
    const excludedFeatures = [1, 2];
    const serverPool = servers.filter(server => 
        !excludedFeatures.includes(server.Features) && server.ExitCountry === countryCode
    );

    if (serverPool.length === 0) {
        console.log(`[!] No Server in country ${countryCode} found\n[!] Please choose a valid country`);
        logger.debug(`No server in country ${countryCode}`);
        process.exit(1);
    }

    const fastestServer = getFastestServer(serverPool);
    openvpnConnect(fastestServer, protocol);
}

/**
 * Connect to the fastest server with a specific feature.
 */
function featureF(feature, protocol = null) {
    logger.debug(`Starting fastest feature connect with feature ${feature}`);
    if (!protocol) {
        protocol = getConfigValue("USER", "default_protocol");
    }
    disconnect(true);
    pullServerData(true);
    const servers = getServers();
    const serverPool = servers.filter(s => s.Features === feature);

    if (serverPool.length === 0) {
        logger.debug("No servers found with users selection. Exiting.");
        console.log("[!] No servers found with your selection.");
        process.exit(1);
    }

    const fastestServer = getFastestServer(serverPool);
    openvpnConnect(fastestServer, protocol);
}

/**
 * Connect to a single given server directly.
 */
function direct(userInput, protocol = null) {
    logger.debug(`Starting direct connect with ${userInput}`);
    pullServerData();
    if (!protocol) {
        protocol = getConfigValue("USER", "default_protocol");
    }

    const reShort = /^((\w\w)(-|#)?(\d{1,3})-?(TOR)?)$/;
    const reLong = /^(((\w\w)(-|#)?([A-Z]{2}|FREE))(-|#)?(\d{1,3})-?(TOR)?)$/;
    userInput = userInput.toUpperCase();

    let servername = "";

    if (reShort.test(userInput)) {
        const match = userInput.match(reShort);
        const countryCode = match[2];
        const number = match[4].replace(/^0+/, '');
        const tor = match[5];
        servername = `${countryCode}#${number}${tor ? '-' + tor : ''}`;
    } else if (reLong.test(userInput)) {
        const match = userInput.match(reLong);
        const countryCode = match[3];
        const countryCode2 = match[5];
        const number = match[7].replace(/^0+/, '');
        const tor = match[8];
        servername = `${countryCode}-${countryCode2}#${number}${tor ? '-' + tor : ''}`;
    } else {
        console.log(`[!] '${userInput}' is not a valid servername\n[!] Please enter a valid servername`);
        logger.debug(`'${userInput}' is not a valid servername`);
        process.exit(1);
    }

    const servers = getServers();
    const serverNames = servers.map(s => s.Name);
    if (!serverNames.includes(servername)) {
        console.log(`[!] ${servername} doesn't exist, is under maintenance, or inaccessible with your plan.\n[!] Please enter a different, valid servername.`);
        logger.debug(`${servername} doesn't exist`);
        process.exit(1);
    }

    openvpnConnect(servername, protocol);
}

/**
 * Reconnect to the last VPN Server.
 */
function reconnect() {
    logger.debug("Starting reconnect");
    try {
        const servername = getConfigValue("metadata", "connected_server");
        const protocol = getConfigValue("metadata", "connected_proto");
        openvpnConnect(servername, protocol);
    } catch (err) {
        logger.debug("No previous connection found");
        console.log("[!] Couldn't find a previous connection\n[!] Please connect normally first");
        process.exit(1);
    }
}

/**
 * Disconnect VPN if a connection is present.
 */
function disconnect(passed = false) {
    logger.debug("Initiating disconnect");
    if (isConnected()) {
        if (passed) {
            console.log("There is already a VPN connection running.");
            console.log("Terminating previous connection...");
        }
        try {
            execSync("pkill openvpn");
        } catch (e) {
            // Ignore if no process found
        }
        
        let timerStart = Date.now();
        while (isConnected()) {
            if ((Date.now() - timerStart) / 1000 <= 5) {
                try { execSync("pkill openvpn"); } catch (e) {}
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            } else {
                try { execSync("pkill -9 openvpn"); } catch (e) {}
                logger.debug("SIGKILL sent");
                break;
            }
        }

        if (isConnected()) {
            console.log("[!] Could not terminate OpenVPN process.");
            process.exit(1);
        } else {
            manageDns("restore");
            manageIpv6("restore");
            manageKillswitch("restore");
            logger.debug("Disconnected");
        }
    } else {
        manageDns("restore");
        manageIpv6("restore");
        manageKillswitch("restore");
        logger.debug("No connection found");
    }

    if (!passed) {
        console.log("Disconnected.");
    }
}

/**
 * Display the current VPN status.
 */
function status() {
    checkInit();
    logger.debug("Getting VPN Status");

    if (!isConnected()) {
        logger.debug("Disconnected");
        console.log("Status: Disconnected");
        if (fs.existsSync(path.join(CONFIG_DIR, "iptables.backup"))) {
            console.log("[!] Kill Switch is currently active.");
            logger.debug("Kill Switch active while VPN disconnected");
        } else {
            const [ip, isp] = getIpInfo();
            console.log(`IP: ${ip}`);
            console.log(`ISP: ${isp}`);
        }
        return;
    }

    pullServerData();
    let connectedServer, connectedProtocol, dnsServer;
    try {
        connectedServer = getConfigValue("metadata", "connected_server");
        connectedProtocol = getConfigValue("metadata", "connected_proto");
        dnsServer = getConfigValue("metadata", "dns_server");
    } catch (err) {
        console.log("It looks like there never was a connection.\nPlease connect with 'protonvpn connect' first.");
        process.exit(1);
    }

    try {
        execSync(`ping -c 1 ${dnsServer}`, { stdio: 'pipe' });
    } catch (err) {
        logger.debug("Could not reach VPN server");
        console.log("[!] Could not reach the VPN Server\n[!] You may want to reconnect with 'protonvpn reconnect'");
        return;
    }

    const servers = getServers();
    const [ip, isp] = getIpInfo();
    const allFeatures = { 0: "Normal", 1: "Secure-Core", 2: "Tor", 4: "P2P" };
    
    logger.debug("Collecting status information");
    const countryCode = getServerValue(connectedServer, "ExitCountry", servers);
    const country = getCountryName(countryCode);
    const city = getServerValue(connectedServer, "City", servers);
    const load = getServerValue(connectedServer, "Load", servers);
    const feature = getServerValue(connectedServer, "Features", servers);
    const lastConnection = getConfigValue("metadata", "connected_time");
    const connectionTimeSec = Math.floor(Date.now() / 1000) - parseInt(lastConnection);

    const killswitchOn = fs.existsSync(path.join(CONFIG_DIR, "iptables.backup"));
    const killswitchStatus = killswitchOn ? "Enabled" : "Disabled";

    const connectionTimeFormatted = new Date(connectionTimeSec * 1000).toISOString().substr(11, 8);
    const [txAmount, rxAmount] = getTransferredData();

    logger.debug("Printing status");
    console.log(
        `Status: Connected\n` +
        `Time: ${connectionTimeFormatted}\n` +
        `IP: ${ip}\n` +
        `Server: ${connectedServer}\n` +
        `Features: ${allFeatures[feature]}\n` +
        `Protocol: ${connectedProtocol.toUpperCase()}\n` +
        `Kill Switch: ${killswitchStatus}\n` +
        `Country: ${country}\n` +
        `City: ${city}\n` +
        `Load: ${load}%\n` +
        `Received: ${rxAmount}\n` +
        `Sent: ${txAmount}`
    );
}

/**
 * Connect to VPN Server via OpenVPN.
 */
function openvpnConnect(servername, protocol) {
    logger.debug("Initiating OpenVPN connection");
    logger.debug(`Connecting to ${servername} via ${protocol.toUpperCase()}`);

    const ports = { udp: 1194, tcp: 443 };
    const servers = getServers();
    const subservers = getServerValue(servername, "Servers", servers);
    const ipList = subservers.map(subserver => subserver.EntryIP);

    createOpenVpnConfig({
        serverlist: ipList,
        protocol: protocol,
        ports: [ports[protocol.toLowerCase()]]
    });

    disconnect(true);
    const [oldIp] = getIpInfo();
    console.log(`Connecting to ${servername} via ${protocol.toUpperCase()}...`);
    patchPassfile(PASSFILE);

    const logStream = fs.openSync(path.join(CONFIG_DIR, "ovpn.log"), "w+");
    const openvpnProcess = spawn("openvpn", [
        "--config", OVPN_FILE,
        "--auth-user-pass", PASSFILE,
        "--dev", "proton0",
        "--dev-type", "tun"
    ], {
        detached: true,
        stdio: ['ignore', logStream, logStream]
    });
    openvpnProcess.unref();
    logger.debug("OpenVPN process started");

    const startTime = Date.now();
    const logPath = path.join(CONFIG_DIR, "ovpn.log");

    // Polling loop for connection success
    const checkInterval = setInterval(() => {
        if (!fs.existsSync(logPath)) return;
        const content = fs.readFileSync(logPath, "utf8");

        if (content.includes("Initialization Sequence Completed")) {
            clearInterval(checkInterval);
            const dnsDhcpRegex = /(dhcp-option DNS )(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
            const match = dnsDhcpRegex.exec(content);
            
            if (match) {
                const dnsServer = match[2];
                setConfigValue("metadata", "dns_server", dnsServer);
                manageDns("leak_protection", dnsServer);
            } else {
                console.log("[!] Could not enable DNS Leak Protection!\n[!] Make sure you are protected!");
            }

            manageIpv6("disable");
            manageKillswitch("enable", protocol.toLowerCase(), ports[protocol.toLowerCase()]);

            const [newIp] = getIpInfo();
            if (oldIp === newIp) {
                logger.debug("Failed to connect. IP didn't change");
                console.log("[!] Connection failed. Reverting all changes...");
                disconnect(true);
            } else {
                console.log("Connected!");
                logger.debug("Connection successful");
            }

            // Write connection metadata
            const config = new configparser(); // Simplified representation
            // Update configuration file logic...
            process.exit(0);
        } else if (content.includes("AUTH_FAILED")) {
            clearInterval(checkInterval);
            console.log("[!] Authentication failed.\n[!] Please make sure that your Username and Password is correct.");
            logger.debug("Authentication failure");
            process.exit(1);
        } else if ((Date.now() - startTime) / 1000 >= 45) {
            clearInterval(checkInterval);
            console.log("Connection failed.");
            logger.debug("Connection failed after 45 Seconds");
            process.exit(1);
        }
    }, 100);
}

function manageDns(mode, dnsServer = false) {
    // Implementation placeholder matching Python functionality
    logger.debug(`Managing DNS: ${mode}`);
}

function manageIpv6(mode) {
    // Implementation placeholder matching Python functionality
    logger.debug(`Managing IPv6: ${mode}`);
}

function manageKillswitch(mode, proto = null, port = null) {
    // Implementation placeholder matching Python functionality
    logger.debug(`Managing Killswitch: ${mode}`);
}

module.exports = {
    randomC,
    fastest,
    countryF,
    featureF,
    direct,
    reconnect,
    disconnect,
    status,
    openvpnConnect
};
