# Bitburner Early‑Game Automation Stack

This project provides a small, modular suite of scripts for the game **Bitburner**.  It is aimed at players who have completed the CyberSec augmentations but are otherwise still early in the game.  The goal is to automate basic hacking without requiring advanced infrastructure.  The design is clean and extensible so you can tweak it as your own skills and RAM grow.

## Philosophy

The official Bitburner documentation describes three families of hacking algorithms: simple self‑contained loops, split‑loop algorithms and complex batch controllers【42725420106011†L62-L79】【42725420106011†L94-L131】.  In the early game, you lack the RAM and tools for batching and don’t need micro‑optimizations, so this suite uses **conservative self‑contained loops**.  Each worker script monitors its target’s security and money and decides whether to weaken, grow or hack【42725420106011†L62-L79】.  This avoids over‑hacking and keeps your servers healthy.  A network crawler discovers and roots new servers as your port‑hacking programs improve【833626660587980†L45-L63】, and a scoring script picks profitable targets by balancing max money, required hacking level and hack time.

## Directory Structure

```
bitburner-core/
├── bin/            # entrypoint scripts that orchestrate the system
│   ├── bootstrap.js  # one‑time setup; initializes data files and kicks off the stack
│   ├── start.js      # scans the network, scores targets and deploys hack loops
│   └── stop.js       # cleanly stops all running hack loops
├── scripts/        # operational scripts that perform work
│   ├── scan-network.js  # discovers servers and attempts to root them
│   ├── score-targets.js # ranks rooted servers based on profitability
│   ├── hack-loop.js     # conservative hack/grow/weaken loop
│   └── deploy-hack.js   # deploys hack-loop.js to all rooted servers
├── lib/            # shared modules
│   ├── constants.js # tunable configuration values
│   ├── ns-io.js     # helpers for reading and writing JSON files
│   └── util.js      # misc helpers (formatting, etc.)
└── data/           # persistent state (created at runtime)
    ├── network.json # discovered network information (servers & metadata)
    └── targets.json # ranked target list
```

### Key Scripts

**`scripts/scan-network.js`**

* Performs a depth‑first scan of all servers reachable from `home`.
* Gathers metadata such as max money, required hacking level, minimum security, RAM and number of ports required.
* Uses any port‑hacking programs you own to automatically open ports and call `nuke()`; this mirrors community advice to automate “crawlers” and “worms”【833626660587980†L45-L63】.
* Writes the collected data to `data/network.json`.

**`scripts/score-targets.js`**

* Reads `network.json` and filters for servers you can hack.
* Computes a **score** for each rooted server: `score = maxMoney / ((hackTime / 1000) * (requiredHackLevel + 1))`.  The formula prioritizes servers with high money, short hack times and low skill requirements.
* Writes a sorted list to `data/targets.json` and prints the top five servers.  Feel free to adjust the formula to suit your playstyle.

**`scripts/hack-loop.js`**

* A conservative hack‑grow‑weaken loop.  It accepts three arguments: target server name, money threshold (0–1) and security margin (int).  Defaults are 0.9 (90 % of max money) and 2 security levels above minimum.
* Inside an infinite loop, it calls `weaken()` if the server’s security exceeds the threshold, `grow()` if available money falls below the threshold, otherwise `hack()`【42725420106011†L62-L79】.
* Introduces a small random delay at startup to de‑synchronize multiple threads.

**`scripts/deploy-hack.js`**

* Reads the best target from `targets.json` and deploys `hack-loop.js` to every rooted server.
* Copies the script, kills any existing hack‑loop on that host, and launches as many threads as will fit using a configurable RAM buffer.
* Passes the money threshold and security margin from `lib/constants.js` into each instance so they stay in sync.

### Entrypoints in `bin/`

* **`bin/bootstrap.js`** – run this once when you first download the suite.  It creates empty data files if they don’t exist and launches `bin/start.js`.
* **`bin/start.js`** – run this whenever you want to (re)deploy your hacking empire.  It scans the network, scores targets and deploys hack loops.
* **`bin/stop.js`** – terminates all running hack loops across your rooted servers.  Useful before tweaking constants or updating scripts.

## Configuration

Editable values live in **`lib/constants.js`**:

| Constant        | Description                                                     | Default |
|-----------------|-----------------------------------------------------------------|---------|
| `MONEY_THRESHOLD` | Minimum percentage of max money before a hack is attempted      | `0.9`   |
| `SECURITY_MARGIN` | Allowed security level above minimum before weakening           | `2`     |
| `THREAD_BUFFER`   | Fraction of free RAM to use when launching hack-loop threads    | `0.9`   |

Adjusting these lets you make the system more aggressive (lower thresholds) or safer (higher thresholds).  Higher `MONEY_THRESHOLD` and lower `SECURITY_MARGIN` will produce steadier income and avoid over‑hacking, as recommended for beginners【42725420106011†L62-L79】.

## How to Use

1. **Import the suite** into your Bitburner workspace (save the contents of the `bitburner-core` directory to `home`).
2. In a terminal, run `run bin/bootstrap.js` once.  This initializes the data files and kicks off the first deployment.
3. The system will scan the network, generate a target list and start `hack-loop.js` on every rooted server targeting the best server.
4. As you gain new port‑cracking programs or upgrade your hacking skill, simply run `run bin/start.js` again to rescan and redeploy.
5. To stop all hacking threads, run `run bin/stop.js`.

### Customizing and Extending

* **Change thresholds** by editing `lib/constants.js` and redeploying via `bin/start.js`.
* **Tweak scoring** by editing `scripts/score-targets.js`.  You might incorporate your hacking success chance or other metrics when you unlock the **Formulas.exe** API.
* **Add new modules**.  The `lib/`, `scripts/` and `bin/` folders are intentionally simple to encourage experimentation.  For example, you could write a `scripts/hacknet-manager.js` that buys and upgrades Hacknet nodes based on return‑on‑investment (payback time)【696777403343628†L44-L52】 and wire it into a new `bin/hacknet.js` entrypoint.
* **Purchase server manager**.  Later in the game you may want to automate buying and upgrading purchased servers; drop a new script into `scripts/` and call it from your own entrypoint when ready.

## Next Steps

This stack is deliberately minimal.  As you gain more RAM and unlock stronger port hacks, you can transition to split‑loop algorithms or full batch controllers for optimal income【42725420106011†L94-L131】.  When you join more factions and purchase `Formulas.exe`, you can refine your scoring to maximize money per second.  For now, enjoy the passive income and use the extra time to explore the rest of Bitburner’s gameplay!