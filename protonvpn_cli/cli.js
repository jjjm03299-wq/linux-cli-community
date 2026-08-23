// Standard Libraries & Configuration Imports
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

// External Libraries
const { program } = require('commander');

// ProtonVPN-CLI Modules & Constants
const connection = require('./connection');
const {
    CLIENT_SUFFIX,
    CONFIG_DIR,
    CONFIG_FILE,
    PASSFILE,
    SPLIT_TUNNEL_FILE,
    USER,
    VERSION
} = require('./constants');
const { logger } = require('./logger');
const {
    changeFileOwner,
    checkInit,
    checkRoot,
    getConfigValue,
    isValidIp,
    pullServerData,
    setConfigValue,
    waitForNetwork
} = require('./utils');

const DEPRECATION_NOTICE = `
/******************************************DEPRECATION NOTICE********************************************/
/*                                                                                                      */
/* Proton VPN is upgrading its OpenVPN infrastructure.                                                  */
/* This means the legacy OpenVPN configuration will stop working on 31 March 2025.                       */
/* After this date, you’ll need to switch to the official Proton VPN for Linux app,                     */
/* or reconfigure OpenVPN or WireGuard manually.                                                        */
/* See:                                                                                                 */
/* - Official app: https://protonvpn.com/support/linux-vpn-setup/                                         */
/* - WireGuard: https://protonvpn.com/support/wireguard-configurations/                                 */
/* - OpenVPN: https://protonvpn.com/support/vpn-config-download/                                         */
/*                                                                                                      */
/********************************************************************************************************/
`;

/**
 * Main entry point for the CLI application.
 */
function main() {
    try {
        cli();
    } catch (error) {
        if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
            process.exit(0);
        }
        console.log("\nQuitting...");
        process.exit(1);
    }
}

/**
 * Configure and run user's input command using Commander.
 */
function cli() {
    console.log(DEPRECATION_NOTICE);

    // Initial log values
    try {
        changeFileOwner(path.join(CONFIG_DIR, "pvpn-cli.log"));
    } catch (e) {
        // Ignore if not root/owner yet
    }

    logger.debug("###########################");
    logger.debug("### NEW PROCESS STARTED ###");
    logger.debug("###########################");
    logger.debug(JSON.stringify(process.argv));
    logger.debug(`USER: ${USER}`);
    logger.debug(`CONFIG_DIR: ${CONFIG_DIR}`);

    program
        .name('protonvpn')
        .version(`ProtonVPN-CLI v${VERSION}`, '-v, --version', 'Display version.')
        .helpOption('-h, --help', 'Show this help message.');

    // init command
    program
        .command('init')
        .description('Initialize a ProtonVPN profile.')
        .action(initCli);

    // connect command (c | connect)
    const connectCmd = program
        .command('connect [servername]')
        .alias('c')
        .description('Connect to a ProtonVPN server.')
        .option('-f, --fastest', 'Select the fastest ProtonVPN server.')
        .option('-r, --random', 'Select a random ProtonVPN server.')
        .option('--cc <code>', 'Determine the country for fastest connect.')
        .option('--sc', 'Connect to the fastest Secure-Core server.')
        .option('--p2p', 'Connect to the fastest torrent server.')
        .option('--tor', 'Connect to the fastest Tor server.')
        .option('-p, --protocol <protocol>', 'Determine the protocol (UDP or TCP).')
        .action(async (servername, options) => {
            checkRoot();
            checkInit();

            if (parseInt(process.env.PVPN_WAIT || "0", 10) > 0) {
                await waitForNetwork(parseInt(process.env.PVPN_WAIT, 10));
            }

            let protocol = options.protocol;
            if (protocol) {
                protocol = protocol.toLowerCase().trim();
                if (!['tcp', 'udp'].includes(protocol)) {
                    protocol = null;
                }
            }

            if (options.random) {
                await connection.random_c(protocol);
            } else if (options.fastest) {
                await connection.fastest(protocol);
            } else if (servername) {
                await connection.direct(servername, protocol);
            } else if (options.cc) {
                await connection.country_f(options.cc, protocol);
            } else if (options.p2p) {
                await connection.feature_f(4, protocol);
            } else if (options.sc) {
                await connection.feature_f(1, protocol);
            } else if (options.tor) {
                await connection.feature_f(2, protocol);
            } else {
                await connection.dialog();
            }
        });

    // reconnect command (r | reconnect)
    program
        .command('reconnect')
        .alias('r')
        .description('Reconnect to the last server.')
        .action(async () => {
            checkRoot();
            checkInit();
            await connection.reconnect();
        });

    // disconnect command (d | disconnect)
    program
        .command('disconnect')
        .alias('d')
        .description('Disconnect the current session.')
        .action(() => {
            checkRoot();
            checkInit();
            connection.disconnect();
        });

    // status command (s | status)
    program
        .command('status')
        .alias('s')
        .description('Show connection status.')
        .action(async () => {
            await connection.status();
        });

    // configure command
    program
        .command('configure')
        .description('Change ProtonVPN-CLI configuration.')
        .action(async () => {
            checkRoot();
            checkInit();
            await configureCli();
        });

    // refresh command
    program
        .command('refresh')
        .description('Refresh OpenVPN configuration and server data.')
        .action(async () => {
            checkInit();
            await pullServerData(true);
        });

    // examples command
    program
        .command('examples')
        .description('Print some example commands.')
        .action(printExamples);

    program.parse(process.argv);
}

/**
 * Initialize the CLI profile interactively.
 */
async function initCli() {
    const ini = require('ini');

    function initConfigFile() {
        const config = {
            USER: {
                username: "None",
                tier: "None",
                default_protocol: "None",
                initialized: "0",
                dns_leak_protection: "1",
                custom_dns: "None",
                check_update_interval: "3",
                api_domain: "https://api.protonvpn.ch",
            },
            metadata: {
                last_api_pull: "0",
                last_update_check: Math.floor(Date.now() / 1000).toString(),
            }
        };
        fs.writeFileSync(CONFIG_FILE, ini.stringify(config));
        changeFileOwner(CONFIG_FILE);
        logger.debug("pvpn-cli.cfg initialized");
    }

    checkRoot();
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        logger.debug("Config Directory created");
        changeFileOwner(CONFIG_DIR);
    }

    try {
        if (parseInt(getConfigValue("USER", "initialized") || "0", 10)) {
            console.log("An initialized profile has been found.");
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const overwrite = await new Promise(resolve => rl.question("Are you sure you want to overwrite that profile? [y/N]: ", resolve));
            rl.close();
            if (overwrite.trim().toLowerCase() !== "y") {
                console.log("Quitting...");
                process.exit(1);
            }
            connection.disconnect(true);
        }
    } catch (e) {
        // Ignore if config not found
    }

    const termWidth = process.stdout.columns || 80;
    console.log("[ -- PROTONVPN-CLI INIT -- ]\n".padStart(Math.floor((termWidth + 28) / 2)));

    const initMsg = [
        "ProtonVPN uses two different sets of credentials, one for the ",
        "website and official apps where the username is most likely your ",
        "e-mail, and one for connecting to the VPN servers.\n",
        "You can find the OpenVPN credentials at ",
        "https://account.protonvpn.com/account.\n",
        "--- Please make sure to use the OpenVPN credentials ---\n"
    ];
    for (const line of initMsg) {
        console.log(line);
    }

    const { username: ovpnUsername, password: ovpnPassword } = await setUsernamePassword(false);
    const userTier = await setProtonvpnTier(false);
    const userProtocol = await setDefaultProtocol(false);

    const protonvpnPlans = { 1: "Free", 2: "Basic", 3: "Plus", 4: "Visionary" };
    console.log(
        "\nYou entered the following information:\n" +
        `Username: ${ovpnUsername}\n` +
        `Password: ${"*".repeat(ovpnPassword.length)}\n` +
        `Tier: ${protonvpnPlans[userTier]}\n` +
        `Default protocol: ${userProtocol.toUpperCase()}\n`
    );

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userConfirmation = await new Promise(resolve => rl.question("Is this information correct? [Y/n]: ", resolve));
    rl.close();

    const confLower = userConfirmation.trim().toLowerCase();
    if (confLower === "y" || confLower === "") {
        console.log("Writing configuration to disk...");
        initConfigFile();
        await pullServerData();

        let adjustedTier = userTier;
        if (adjustedTier === 4) adjustedTier = 3;
        adjustedTier -= 1;

        setConfigValue("USER", "username", ovpnUsername);
        setConfigValue("USER", "tier", adjustedTier);
        setConfigValue("USER", "default_protocol", userProtocol);
        setConfigValue("USER", "dns_leak_protection", 1);
        setConfigValue("USER", "custom_dns", "None");
        setConfigValue("USER", "killswitch", 0);

        fs.writeFileSync(PASSFILE, `${ovpnUsername}+${CLIENT_SUFFIX}\n${ovpnPassword}`);
        logger.debug("Passfile created");
        fs.chmodSync(PASSFILE, 0o600);
        setConfigValue("USER", "initialized", 1);

        console.log("\nDone! Your account has been successfully initialized.");
        logger.debug("Initialization completed.");
    } else {
        console.log("\nPlease restart the initialization process.");
        process.exit(1);
    }
}

/**
 * Print examples on how to use this program.
 */
function printExamples() {
    const examples = (
        "protonvpn connect\n" +
        " Display a menu and select server interactively.\n\n" +
        "protonvpn c BE-5\n" +
        " Connect to BE#5 with the default protocol.\n\n" +
        "protonvpn connect NO#3 -p tcp\n" +
        " Connect to NO#3 with TCP.\n\n" +
        "protonvpn c --fastest\n" +
        " Connect to the fastest VPN Server.\n\n" +
        "protonvpn connect --cc AU\n" +
        " Connect to the fastest Australian server\n" +
        " with the default protocol.\n\n" +
        "protonvpn c --p2p -p tcp\n" +
        " Connect to the fastest torrent server with TCP.\n\n" +
        "protonvpn c --sc\n" +
        " Connect to the fastest Secure-Core server with\n" +
        " the default protocol.\n\n" +
        "protonvpn reconnect\n" +
        " Reconnect the currently active session or connect\n" +
        " to the last connected server.\n\n" +
        "protonvpn disconnect\n" +
        " Disconnect the current session.\n\n" +
        "protonvpn s\n" +
        " Print information about the current session."
    );
    console.log(examples);
}

/**
 * Change single configuration values interactively.
 */
async function configureCli() {
    const rlInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rlInterface.question(query, resolve));

    while (true) {
        console.log(
            "What do you want to change?\n\n" +
            "1) Username and Password\n" +
            "2) ProtonVPN Plan\n" +
            "3) Default Protocol\n" +
            "4) DNS Management\n" +
            "5) Kill Switch\n" +
            "6) Split Tunneling\n" +
            "7) Purge Configuration\n"
        );

        let userChoice = await question("Please enter your choice or leave empty to quit: ");
        userChoice = userChoice.toLowerCase().trim();

        if (userChoice === "1") {
            rlInterface.close();
            await setUsernamePassword(true);
            break;
        } else if (userChoice === "2") {
            rlInterface.close();
            await setProtonvpnTier(true);
            break;
        } else if (userChoice === "3") {
            rlInterface.close();
            await setDefaultProtocol(true);
            break;
        } else if (userChoice === "4") {
            rlInterface.close();
            await setDnsProtection();
            break;
        } else if (userChoice === "5") {
            rlInterface.close();
            await setKillswitch();
            break;
        } else if (userChoice === "6") {
            rlInterface.close();
            await setSplitTunnel();
            break;
        } else if (userChoice === "7") {
            rlInterface.close();
            await purgeConfiguration();
            break;
        } else if (userChoice === "") {
            rlInterface.close();
            console.log("Quitting configuration.");
            process.exit(0);
        } else {
            console.log("[!] Invalid choice. Please enter the number of your choice.\n");
            await new Promise(res => setTimeout(res, 500));
        }
    }
}

/**
 * Purges CLI configuration.
 */
async function purgeConfiguration() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userChoice = await new Promise(resolve => rl.question("Are you sure you want to purge the configuration? [y/N]: ", resolve));
    rl.close();

    if (userChoice.trim().toLowerCase() !== "y") {
        console.log("Okay :(");
        return;
    }
    await new Promise(res => setTimeout(res, 500));
    connection.disconnect(true);

    if (fs.existsSync(CONFIG_DIR)) {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
    }
    console.log("Configuration purged.");
}

/**
 * Set the ProtonVPN Username and Password.
 */
async function setUsernamePassword(write = false) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    console.log();
    const ovpnUsername = await question("Enter your ProtonVPN OpenVPN username: ");

    let ovpnPassword1 = "";
    while (true) {
        // Note: Standard readline echoes password; for hidden input, prompt or external packages are used.
        ovpnPassword1 = await question("Enter your ProtonVPN OpenVPN password: ");
        const ovpnPassword2 = await question("Confirm your ProtonVPN OpenVPN password: ");
        if (ovpnPassword1 !== ovpnPassword2) {
            console.log("\n[!] The passwords do not match. Please try again.");
        } else {
            break;
        }
    }
    rl.close();

    if (write) {
        setConfigValue("USER", "username", ovpnUsername);
        fs.writeFileSync(PASSFILE, `${ovpnUsername}\n${ovpnPassword1}`);
        logger.debug("Passfile updated");
        fs.chmodSync(PASSFILE, 0o600);
        console.log("Username and Password has been updated!");
    }

    return { username: ovpnUsername, password: ovpnPassword1 };
}

/**
 * Set the users ProtonVPN Plan.
 */
async function setProtonvpnTier(write = false) {
    const protonvpnPlans = { 1: "Free", 2: "Basic", 3: "Plus", 4: "Visionary" };
    console.log("\nPlease choose your ProtonVPN Plan");
    for (const plan in protonvpnPlans) {
        console.log(`${plan}) ${protonvpnPlans[plan]}`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    let userTier;
    while (true) {
        console.log();
        const inputVal = await question("Your plan: ");
        try {
            userTier = parseInt(inputVal, 10);
            if (protonvpnPlans[userTier]) break;
        } catch (e) {
            // continue loop
        }
        console.log("\n[!] Invalid choice. Please enter the number of your plan.");
    }
    rl.close();

    if (write) {
        let adjustedTier = userTier;
        if (adjustedTier === 4) adjustedTier = 3;
        adjustedTier -= 1;
        setConfigValue("USER", "tier", adjustedTier.toString());
        console.log("ProtonVPN Plan has been updated!");
    }

    return userTier;
}

/**
 * Set the user's default protocol.
 */
async function setDefaultProtocol(write = false) {
    console.log(
        "\nChoose the default OpenVPN protocol.\n" +
        "OpenVPN can act on two different protocols: UDP and TCP.\n" +
        "UDP is preferred for speed but might be blocked in some networks.\n" +
        "TCP is not as fast but a lot harder to block.\n" +
        "Input your preferred protocol. (Default: UDP)\n"
    );

    const protonvpnProtocols = { 1: "UDP", 2: "TCP" };
    for (const p in protonvpnProtocols) {
        console.log(`${p}) ${protonvpnProtocols[p]}`);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    let userProtocol = "udp";
    while (true) {
        console.log();
        let userProtocolChoice = await question("Your choice: ");
        try {
            if (userProtocolChoice.trim() === "") userProtocolChoice = "1";
            const choiceNum = parseInt(userProtocolChoice, 10);
            if (protonvpnProtocols[choiceNum]) {
                userProtocol = protonvpnProtocols[choiceNum].toLowerCase();
                break;
            }
        } catch (e) {
            // continue loop
        }
        console.log("\n[!] Invalid choice. Please enter the number of your preferred protocol.");
    }
    rl.close();

    if (write) {
        setConfigValue("USER", "default_protocol", userProtocol);
        console.log("Default protocol has been updated.");
    }

    return userProtocol;
}

/**
 * Enable or disable DNS Leak Protection and custom DNS.
 */
async function setDnsProtection() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    let dnsLeakProtection = 1;
    let customDns = null;

    while (true) {
        console.log(
            "\nDNS Leak Protection makes sure that you always use ProtonVPN's DNS servers.\n" +
            "For security reasons this option is recommended.\n\n" +
            "1) Enable DNS Leak Protection (recommended)\n" +
            "2) Configure Custom DNS Servers\n" +
            "3) Disable DNS Management\n"
        );

        let userChoice = await question("Please enter your choice or leave empty to quit: ");
        userChoice = userChoice.toLowerCase().trim();

        if (userChoice === "1") {
            dnsLeakProtection = 1;
            customDns = "None";
            break;
        } else if (userChoice === "2") {
            dnsLeakProtection = 0;
            const dnsInput = await question("Please enter your custom DNS servers (space separated): ");
            customDns = dnsInput.trim().split(/\s+/);
            if (customDns.length > 3) {
                console.log("[!] Don't enter more than 3 DNS Servers");
                rl.close();
                return;
            }
            let valid = true;
            for (const dns of customDns) {
                if (!isValidIp(dns)) {
                    console.log(`[!] ${dns} is invalid. Please try again.`);
                    valid = false;
                    break;
                }
            }
            if (!valid) continue;
            customDns = customDns.join(" ");
            break;
        } else if (userChoice === "3") {
            dnsLeakProtection = 0;
            customDns = "None";
            break;
        } else if (userChoice === "") {
            console.log("Quitting configuration.");
            rl.close();
            process.exit(0);
        } else {
            console.log("[!] Invalid choice. Please enter the number of your choice.\n");
            await new Promise(res => setTimeout(res, 500));
        }
    }
    rl.close();

    setConfigValue("USER", "dns_leak_protection", dnsLeakProtection);
    setConfigValue("USER", "custom_dns", customDns);
    console.log("DNS Management updated.");
}

/**
 * Enable or disable the Kill Switch.
 */
async function setKillswitch() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    let killswitch = 0;
    while (true) {
        console.log(
            "\nThe Kill Switch will block all network traffic\n" +
            "if the VPN connection drops unexpectedly.\n\n" +
            "Please note that the Kill Switch assumes only one network interface being active.\n\n" +
            "1) Enable Kill Switch (Block access to/from LAN)\n" +
            "2) Enable Kill Switch (Allow access to/from LAN)\n" +
            "3) Disable Kill Switch\n"
        );

        let userChoice = await question("Please enter your choice or leave empty to quit: ");
        userChoice = userChoice.toLowerCase().trim();

        if (userChoice === "1") {
            killswitch = 1;
            break;
        } else if (userChoice === "2") {
            killswitch = 2;
            break;
        } else if (userChoice === "3") {
            killswitch = 0;
            break;
        } else if (userChoice === "") {
            console.log("Quitting configuration.");
            rl.close();
            process.exit(0);
        } else {
            console.log("[!] Invalid choice. Please enter the number of your choice.\n");
            await new Promise(res => setTimeout(res, 500));
        }
    }
    rl.close();

    if (killswitch && parseInt(getConfigValue("USER", "split_tunnel") || "0", 10)) {
        setConfigValue("USER", "split_tunnel", 0);
        console.log("\n[!] Kill Switch can't be used with Split Tunneling.\n[!] Split Tunneling has been disabled.");
        await new Promise(res => setTimeout(res, 1000));
    }

    setConfigValue("USER", "killswitch", killswitch);
    console.log("\nKill Switch configuration updated.");
}

/**
 * Enable or disable split tunneling.
 */
async function setSplitTunnel() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (query) => new Promise(resolve => rl.question(query, resolve));

    const userChoice = await question("Enable split tunneling? [y/N]: ");
    if (userChoice.trim().toLowerCase() === "y") {
        if (parseInt(getConfigValue("USER", "killswitch") || "0", 10)) {
            setConfigValue("USER", "killswitch", 0);
            console.log("\n[!] Split Tunneling can't be used with Kill Switch.\n[!] Kill Switch has been disabled.\n");
            await new Promise(res => setTimeout(res, 1000));
        }
        setConfigValue("USER", "split_tunnel", 1);

        while (true) {
            const ip = await question("Please enter an IP or CIDR to exclude from VPN.\nOr leave empty to stop: ");
            const trimmedIp = ip.trim();
            if (trimmedIp === "") break;
            if (!isValidIp(trimmedIp)) {
                console.log("[!] Invalid IP\n");
                continue;
            }
            fs.appendFileSync(SPLIT_TUNNEL_FILE, `\n${trimmedIp}`);
        }

        if (fs.existsSync(SPLIT_TUNNEL_FILE)) {
            changeFileOwner(SPLIT_TUNNEL_FILE);
        } else {
            logger.debug("No split tunneling file existing.");
            setConfigValue("USER", "split_tunnel", 0);
        }
    } else {
        setConfigValue("USER", "split_tunnel", 0);
        if (fs.existsSync(SPLIT_TUNNEL_FILE)) {
            const clearConfig = await question("Remove split tunnel configuration? [y/N]: ");
            if (clearConfig.trim().toLowerCase() === "y") {
                fs.unlinkSync(SPLIT_TUNNEL_FILE);
            }
        }
    }
    rl.close();
    console.log("\nSplit tunneling configuration updated.");
}

if (require.main === module) {
    main();
}

module.exports = {
    main,
    cli,
    initCli,
    configureCli
};
