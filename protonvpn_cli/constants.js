// Standard Libraries & Configuration Imports
const os = require('os');
const path = require('path');
const getpass = require('getpass'); // Or handle user retrieval via process.env / system calls
const { execSync } = require('child_process');

/**
 * Determine the active username, supporting GUI / pkexec contexts.
 */
function resolveUser() {
    try {
        if (process.env.PKEXEC_UID) {
            const uid = parseInt(process.env.PKEXEC_UID, 10);
            const stdout = execSync(`getent passwd ${uid}`).toString();
            return stdout.split(':')[0];
        }
    } catch (e) {
        // Fallback if lookup fails
    }

    if (process.env.SUDO_USER) {
        return process.env.SUDO_USER;
    }

    try {
        return os.userInfo().username;
    } catch (e) {
        return "root";
    }
}

const USER = resolveUser();
const HOME_DIR = os.homedir() || path.join('/home', USER);

const CONFIG_DIR = path.join(HOME_DIR, ".pvpn-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "pvpn-cli.cfg");
const SERVER_INFO_FILE = path.join(CONFIG_DIR, "serverinfo.json");
const SPLIT_TUNNEL_FILE = path.join(CONFIG_DIR, "split_tunnel.txt");
const OVPN_FILE = path.join(CONFIG_DIR, "connect.ovpn");
const PASSFILE = path.join(CONFIG_DIR, "pvpnpass");

const CLIENT_SUFFIX = "plc"; // ProtonVPN Linux Community
const VERSION = "2.2.12";

module.exports = {
    USER,
    CONFIG_DIR,
    CONFIG_FILE,
    SERVER_INFO_FILE,
    SPLIT_TUNNEL_FILE,
    OVPN_FILE,
    PASSFILE,
    CLIENT_SUFFIX,
    VERSION
};
