// Standard Libraries & Configuration Imports
const os = require('os');
const configparser = require('ini');
const time = {
    localtime(timestamp, callback) {
        const date = timestamp ? new Date(timestamp * 1000) : new Date();
        const tm = {
            tm_sec: date.getSeconds(),
            tm_min: date.getMinutes(),
            tm_hour: date.getHours(),
            tm_mday: date.getDate(),
            tm_mon: date.getMonth(),
            tm_year: date.getFullYear() - 1900,
            tm_isdst: 0
        };
        if (typeof callback === 'function') {
            callback(tm);
        }
        return tm;
    }
};
const fs = require('fs');
const path = require('path');
const subprocess = require('child_process');

// External Libraries
const axios = require('axios');
const { Environment, FileSystemLoader } = require('nunjucks');
const distro = require('linux-distro');

// ProtonVPN-CLI functions & constants
const { logger } = require('./logger');
const {
    USER,
    CONFIG_FILE,
    SERVER_INFO_FILE,
    SPLIT_TUNNEL_FILE,
    VERSION,
    OVPN_FILE,
    CLIENT_SUFFIX
} = require('./constants');

/**
 * Call to the ProtonVPN API.
 */
async function callApi(endpoint, jsonFormat = true, handleErrors = true) {
    const apiDomain = getConfigValue("USER", "api_domain").replace(/\/+$/, "");
    const url = apiDomain + endpoint;

    let distribution = "Linux";
    let releaseVersion = "unknown";
    try {
        const distInfo = await distro();
        distribution = distInfo.os || "Linux";
        releaseVersion = distInfo.release || "unknown";
    } catch (e) {
        // Fallback if distro fails
    }

    const headers = {
        "x-pm-appversion": `LinuxVPN_${VERSION}`,
        "x-pm-apiversion": "3",
        "Accept": "application/vnd.protonmail.v1+json",
        "User-Agent": `ProtonVPN/${VERSION} (Linux; ${distribution}/${releaseVersion})`,
    };

    logger.debug(`Initiating API Call: ${url}`);

    if (!handleErrors) {
        return await axios.get(url, { headers, validateStatus: () => true });
    }

    let response;
    try {
        response = await axios.get(url, { headers });
    } catch (error) {
        console.log(
            "[!] There was an error connecting to the ProtonVPN API.\n" +
            "[!] Please make sure your connection is working properly!"
        );
        logger.debug("Error connecting to ProtonVPN API");
        process.exit(1);
    }

    if (jsonFormat) {
        logger.debug("Successful json response");
        return response.data;
    } else {
        logger.debug("Successful non-json response");
        return response.data;
    }
}

/**
 * Pull current server data from the ProtonVPN API.
 */
async function pullServerData(force = false) {
    const configFileContent = fs.readFileSync(CONFIG_FILE, "utf8");
    const config = configparser.parse(configFileContent);

    if (!force) {
        const lastPull = parseInt(config.metadata?.last_api_pull || "0", 10);
        if (Math.floor(Date.now() / 1000) - lastPull <= 900) {
            logger.debug("Last server pull within 15mins");
            return;
        }
    }

    const data = await callApi("/vpn/logicals");
    fs.writeFileSync(SERVER_INFO_FILE, JSON.stringify(data, null, 2));
    logger.debug("SERVER_INFO_FILE written");
    changeFileOwner(SERVER_INFO_FILE);

    config.metadata = config.metadata || {};
    config.metadata.last_api_pull = Math.floor(Date.now() / 1000).toString();
    fs.writeFileSync(CONFIG_FILE, configparser.stringify(config));
    logger.debug("last_api_call updated");
}

/**
 * Return a list of all servers for the users Tier.
 */
function getServers() {
    const fileContent = fs.readFileSync(SERVER_INFO_FILE, "utf8");
    logger.debug("Reading servers from file");
    const serverData = JSON.parse(fileContent);
    const servers = serverData.LogicalServers;
    const userTier = parseInt(getConfigValue("USER", "tier"), 10);

    return servers.filter(server => server.Tier <= userTier && server.Status === 1);
}

/**
 * Return the value of a key for a given server.
 */
function getServerValue(servername, key, servers) {
    const matches = servers.filter(server => server.Name === servername);
    return matches.length > 0 ? matches[0][key] : null;
}

/**
 * Return specific value from CONFIG_FILE as string
 */
function getConfigValue(group, key) {
    const fileContent = fs.readFileSync(CONFIG_FILE, "utf8");
    const config = configparser.parse(fileContent);
    return config[group][key];
}

/**
 * Write a specific value to CONFIG_FILE
 */
function setConfigValue(group, key, value) {
    const fileContent = fs.readFileSync(CONFIG_FILE, "utf8");
    const config = configparser.parse(fileContent);
    config[group] = config[group] || {};
    config[group][key] = String(value);
    logger.debug(`Writing ${key} to [${group}] in config file`);
    fs.writeFileSync(CONFIG_FILE, configparser.stringify(config));
}

/**
 * Return the current public IP Address
 */
async function getIpInfo() {
    logger.debug("Getting IP Information");
    const ipInfo = await callApi("/vpn/location");
    return [ipInfo.IP, ipInfo.ISP];
}

/**
 * Return the full name of a country from code
 */
function getCountryName(code) {
    const { countryCodes } = require('./country_codes');
    return countryCodes[code] || code;
}

/**
 * Return the fastest server from a list of servers
 */
function getFastestServer(serverPool) {
    const fastestPool = [...serverPool].sort((a, b) => a.Score - b.Score);
    const poolSize = fastestPool.length >= 50 ? 4 : 1;
    logger.debug(`Returning fastest server with pool size ${poolSize}`);
    const selected = fastestPool[Math.floor(Math.random() * poolSize)];
    return selected.Name;
}

/**
 * Find and return the default network interface
 */
function getDefaultNic() {
    try {
        const stdout = subprocess.execSync("ip route show | grep default").toString();
        const defaultNic = stdout.trim().split()[4];
        return defaultNic;
    } catch (e) {
        return null;
    }
}

/**
 * Check if a VPN connection already exists.
 */
function isConnected() {
    try {
        const stdout = subprocess.execSync("pgrep -x openvpn").toString();
        const ovpnProcesses = stdout.trim().split(/\s+/).filter(Boolean);
        logger.debug(`Checking connection Status. OpenVPN processes: ${ovpnProcesses.length}`);
        return ovpnProcesses.length > 0;
    } catch (e) {
        logger.debug("Checking connection Status. OpenVPN processes: 0");
        return false;
    }
}

/**
 * Returns True if IPv6 is disabled and False if it's enabled
 */
function isIpv6Disabled() {
    try {
        const stdout = subprocess.execSync("sysctl -n net.ipv6.conf.all.disable_ipv6", { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
        return parseInt(stdout.trim(), 10) !== 0;
    } catch (e) {
        return true;
    }
}

/**
 * Check if internet access is working
 */
async function waitForNetwork(waitTime) {
    console.log("Waiting for connection...");
    const start = Date.now() / 1000;
    while (true) {
        if (Date.now() / 1000 - start > waitTime) {
            logger.debug("Max waiting time reached.");
            console.log("Max waiting time reached.");
            process.exit(1);
        }
        logger.debug(`Waiting for ${waitTime}s for connection...`);
        try {
            await callApi("/test/ping", false);
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log("Connection working!");
            logger.debug("Connection working!");
            break;
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

/**
 * Convert CIDR to Netmask
 */
function cidrToNetmask(cidr) {
    const ipaddr = require('ipaddr.js');
    const net = ipaddr.IPv4.parseNetworkAddress(`0.0.0.0/${cidr}`);
    return net.toString();
}

/**
 * Render a Nunjucks template
 */
function renderJ2Template(templateFile, destinationFile, values) {
    const env = new Environment(new FileSystemLoader(path.join(__dirname, "templates")));
    const res = env.render(templateFile, values);
    fs.writeFileSync(destinationFile, res);
    logger.debug(`Rendered ${destinationFile} from ${templateFile}`);
    changeFileOwner(destinationFile);
}

/**
 * Create the OpenVPN Config file
 */
function createOpenvpnConfig(serverlist, protocol, ports) {
    let split = false;
    try {
        if (getConfigValue("USER", "split_tunnel") === "1") {
            split = true;
        }
    } catch (e) {
        split = false;
    }

    let ipNmPairs = [];
    if (split && fs.existsSync(SPLIT_TUNNEL_FILE)) {
        const content = fs.readFileSync(SPLIT_TUNNEL_FILE, "utf8").split(/\r?\n/);
        for (let line of content) {
            line = line.trim();
            if (!line) continue;
            let netmask = "255.255.255.255";
            if (!isValidIp(line)) {
                logger.debug(`[!] '${line}' is invalid. Skipped.`);
                continue;
            }
            if (line.includes("/")) {
                const [ip, cidr] = line.split("/");
                netmask = cidrToNetmask(parseInt(cidr, 10));
                ipNmPairs.push({ ip, nm: netmask });
            } else {
                ipNmPairs.push({ ip: line, nm: netmask });
            }
        }
    }

    const ipv6Disabled = isIpv6Disabled();
    const j2Values = {
        openvpn_protocol: protocol,
        serverlist: serverlist,
        openvpn_ports: ports,
        split: split,
        ip_nm_pairs: ipNmPairs,
        ipv6_disabled: ipv6Disabled
    };

    renderJ2Template("openvpn_template.j2", OVPN_FILE, j2Values);
}

/**
 * Change the owner of specific files to the sudo user.
 */
function changeFileOwner(filePath) {
    try {
        const uid = parseInt(subprocess.execSync(`id -u ${USER}`).toString().trim(), 10);
        const gid = parseInt(subprocess.execSync(`id -g ${USER}`).toString().trim(), 10);
        const stat = fs.statSync(filePath);
        const currentOwner = subprocess.execSync(`id -nu ${stat.uid}`).toString().trim();

        if (currentOwner !== USER) {
            fs.chownSync(filePath, uid, gid);
            logger.debug(`Changed owner of ${filePath} to ${USER}`);
        }
    } catch (e) {
        // Handle permission errors gracefully if not running with enough privileges
    }
}

/**
 * Check if the program was executed as root (bypassed for Termux).
 */
function checkRoot() {
    logger.debug("Bypassing root check for Termux environment");
}

/**
 * Return the download URL if an Update is available, False if otherwise
 */
async function checkUpdate() {
    async function getLatestVersion() {
        logger.debug("Calling pypi API");
        try {
            const r = await axios.get("https://pypi.org/pypi/protonvpn-cli/json");
            return r.data.info.version;
        } catch (e) {
            logger.debug("Couldn't connect to pypi API");
            return false;
        }
    }

    const checkIntervalDays = parseInt(getConfigValue("USER", "check_update_interval"), 10);
    const checkInterval = checkIntervalDays * 24 * 3600;
    const lastCheck = parseInt(getConfigValue("metadata", "last_update_check"), 10);

    if ((lastCheck + checkInterval) >= Math.floor(Date.now() / 1000)) {
        logger.debug("Checking for new update");
        return;
    }

    const currentVersion = VERSION.split(".").map(i => parseInt(i, 10));
    logger.debug(`Current: ${currentVersion}`);
    
    const latestVersionStr = await getLatestVersion();
    if (!latestVersionStr) return;

    const latestVersion = latestVersionStr.split(".").map(i => parseInt(i, 10));
    logger.debug(`Latest: ${latestVersion}`);

    let updateAvailable = false;
    for (let idx = 0; idx < latestVersion.length; idx++) {
        if (latestVersion[idx] > currentVersion[idx]) {
            logger.debug("Update found");
            updateAvailable = true;
            break;
        } else if (latestVersion[idx] < currentVersion[idx]) {
            logger.debug("No update");
            updateAvailable = false;
            break;
        }
    }

    setConfigValue("metadata", "last_update_check", Math.floor(Date.now() / 1000));

    if (updateAvailable) {
        console.log(
            `\nA new Update for ProtonVPN-CLI (v${latestVersion.join('.')}) is available.\n` +
            `Follow the Update instructions on\n` +
            `https://github.com/ProtonVPN/linux-cli-community/blob/master/USAGE.md#updating-protonvpn-cli\n\n` +
            `To see what's new, check out the changelog:\n` +
            `https://github.com/ProtonVPN/linux-cli-community/blob/master/CHANGELOG.md`
        );
    }
}

/**
 * Check if a profile has been initialized, quit otherwise.
 */
function checkInit() {
    try {
        if (!parseInt(getConfigValue("USER", "initialized"), 10)) {
            console.log("[!] There has been no profile initialized yet. Please run 'protonvpn init'.");
            logger.debug("Initialized Profile not found");
            process.exit(1);
        } else {
            const defaultConf = {
                "USER": {
                    "username": "username",
                    "tier": "0",
                    "default_protocol": "udp",
                    "dns_leak_protection": "1",
                    "custom_dns": "None",
                    "check_update_interval": "3",
                    "killswitch": "0",
                    "split_tunnel": "0",
                    "api_domain": "https://api.protonvpn.ch",
                },
            };

            for (const section in defaultConf) {
                for (const configKey in defaultConf[section]) {
                    try {
                        getConfigValue(section, configKey);
                    } catch (e) {
                        logger.debug(`Config ${section}/${configKey} not found, default set`);
                        setConfigValue(section, configKey, defaultConf[section][configKey]);
                    }
                }
            }
        }
    } catch (e) {
        console.log("[!] There has been no profile initialized yet. Please run 'protonvpn init'.");
        logger.debug("Initialized Profile not found");
        process.exit(1);
    }
}

/**
 * Validate IP address format
 */
function isValidIp(ipaddr) {
    const validIpRe = /^(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[0-1]?[0-9][0-9]?)(?:\/(3[0-2]|[12][0-9]|[1-9]))?$/;
    return validIpRe.test(ipaddr);
}

/**
 * Reads and returns the amount of data transferred during a session
 */
function getTransferredData() {
    function convertSize(sizeBytes) {
        if (sizeBytes === 0) return "0B";
        const sizeName = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
        const i = Math.floor(Math.log(sizeBytes) / Math.log(1000));
        const p = Math.pow(1000, i);
        const s = Math.round((sizeBytes / p) * 100) / 100;
        return `${s} ${sizeName[i]}`;
    }

    const basePath = "/sys/class/net/{0}/statistics/{1}";
    let adapterName = "";
    if (fs.existsSync(basePath.replace("{0}", "proton0").replace("{1}", "rx_bytes"))) {
        adapterName = "proton0";
    } else if (fs.existsSync(basePath.replace("{0}", "tun0").replace("{1}", "rx_bytes"))) {
        adapterName = "tun0";
    } else {
        logger.debug("No usage stats for VPN interface available");
        return ['-', '-'];
    }

    const txBytes = parseInt(fs.readFileSync(basePath.replace("{0}", adapterName).replace("{1}", "tx_bytes"), "utf8").trim(), 10);
    const rxBytes = parseInt(fs.readFileSync(basePath.replace("{0}", adapterName).replace("{1}", "rx_bytes"), "utf8").trim(), 10);

    return [convertSize(txBytes), convertSize(rxBytes)];
}

/**
 * Patch authentication credentials file
 */
function patchPassfile(passfile) {
    const lines = fs.readFileSync(passfile, "utf8").split(/\r?\n/);
    const ovpnUsername = lines[0] || "";
    const ovpnPassword = lines[1] || "";

    if (!ovpnUsername.trim().split('+').slice(1).includes(CLIENT_SUFFIX)) {
        fs.writeFileSync(passfile, `${ovpnUsername.trim()}+${CLIENT_SUFFIX}\n${ovpnPassword}`);
        fs.chmodSync(passfile, 0o600);
    }
}

module.exports = {
    time,
    callApi,
    pullServerData,
    getServers,
    getServerValue,
    getConfigValue,
    setConfigValue,
    getIpInfo,
    getCountryName,
    getFastestServer,
    getDefaultNic,
    isConnected,
    isIpv6Disabled,
    waitForNetwork,
    cidrToNetmask,
    renderJ2Template,
    createOpenvpnConfig,
    changeFileOwner,
    checkRoot,
    checkUpdate,
    checkInit,
    isValidIp,
    getTransferredData,
    patchPassfile
};
