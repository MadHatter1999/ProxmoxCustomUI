# The node agent

`agent/proxbox-android-agent.mjs` — one file, Node standard library only, no npm
tree on a hypervisor.

Two jobs, and only two:

1. Tell the controller what this node can do and what Android hardware is
   plugged into it. Every 15 seconds.
2. Do exactly what the controller asks, over a signed local API: run an adb
   command, start or stop an emulator, resolve a MAC to an address.

It is the only process anywhere that runs `adb`.

## Install

On the node, as root:

```bash
# Copy the agent directory to the node first (scp, or clone the repo).
./install-android-agent.sh \
    --controller http://proxbox.lab.local:8080 \
    --token "$(cat /etc/proxbox/android-token)"

# Add --with-sdk on nodes that should run Google emulator devices:
./install-android-agent.sh --controller … --token … --with-sdk
```

The installer:

- installs `android-tools-adb`, `nodejs`, and `scrcpy` if the repo has it
  (scrcpy is optional — it is only for the future higher-quality screen path)
- drops the agent in `/opt/proxbox/`
- writes `/etc/proxbox/android-agent.env` mode 0600
- optionally installs the Android SDK command-line tools into `/opt/android-sdk`
- enables `proxbox-android-agent.service`

Nothing it does touches existing VMs, storage or cluster configuration.

## The shared token

One secret, shared by the controller and every agent. Generate it once:

```bash
# On the controller:
openssl rand -hex 32 > /etc/proxbox/android-token
chmod 600 /etc/proxbox/android-token

# Then set it for the ProxBox server process, e.g. in its systemd unit:
ANDROID_AGENT_TOKEN=<that value>
```

With no token set, the controller refuses every agent and the subsystem stays
registry-only — it will show the catalogue and say "no node is running the
Android agent yet". That is the safe default and it is deliberate.

Per-node keys would be better and are a strictly better version of the same
mechanism; see [platform.md](platform.md).

## Verify

```bash
systemctl status proxbox-android-agent
journalctl -u proxbox-android-agent -f

# What the node can see:
adb devices -l

# What the controller thinks:
curl -s --cookie "PVEAuthCookie=…" http://proxbox.lab.local:8080/svc/android/nodes | jq
```

The node should appear under Devices → Nodes within about 15 seconds.

## The agent API

Every request must carry `x-proxbox-ts` and `x-proxbox-sig`, an HMAC-SHA256 over
`ts \n METHOD \n path \n sha256(body)`. Five-minute skew window. Unsigned
requests get a 401 and nothing else.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/capabilities` | everything about this node |
| `GET` | `/devices` | `adb devices -l`, enriched per device |
| `POST` | `/adb` | `{serial, args[], stdin?, timeoutMs?}` → `{code, stdout(base64), stderr}` |
| `POST` | `/connect` | `{target: "ip:5555"}` |
| `POST` | `/disconnect` | `{target}` |
| `POST` | `/net/ip-for-mac` | `{mac}` → `{ip?}` |
| `POST` | `/sdk/ensure` | `{packageName}` — downloads a system image if missing |
| `POST` | `/avd/create` | full AVD spec including width/height/dpi/hardware |
| `POST` | `/avd/start` | `{avd, gpu, headless, wipeData?, snapshot?}` → `{serial, port}` |
| `POST` | `/avd/stop` | `{avd}` |
| `POST` | `/avd/delete` | `{avd}` |

### The `@stdin` convention

`adb install` needs a real file, and the controller should not have to stage
files on nodes and then remember to clean them up. So `@stdin` anywhere in the
`args` array is replaced by a temp file holding the request body, which is
removed when the command finishes:

```json
{ "serial": "emulator-5554",
  "args": ["install", "-r", "-g", "@stdin"],
  "stdin": "<base64 APK>" }
```

The same convention carries `adb push`.

### Why argv arrays everywhere

`spawn(cmd, args)`, never a shell string, on both sides of the wire. A package
name or filename typed into the ProxBox UI cannot become a command on a Proxmox
host. The only place a shell is used at all is `command -v` for binary detection
and the two `sdkmanager`/`avdmanager` invocations that genuinely need `yes |`
piping, and neither takes user input.

## Resource footprint

Idle: one Node process, roughly 9 MB RSS, one HTTP listener, one 15-second
timer. The heartbeat shells out to `lspci`, `df` and `adb devices` — a few tens
of milliseconds every 15 seconds.

Per emulator device: one detached `emulator` process, sized by the device's own
RAM and cores. The agent tracks it by AVD name and does not hold it open.

## Operating notes

**Emulator ports.** Serials are even ports from 5554 upward; the agent finds a
free one by checking both `adb devices` and its own map. The ceiling is 5680,
so 64 emulator devices per node — far past what any of these machines will run.

**A rebooted node** loses its emulator devices. They show as `offline` and can
be started again; nothing is orphaned and nothing is silently lost. QEMU devices
come back with the node, because they are Proxmox's problem.

**`adb` gets into odd states.** The usual fix applies:
`adb kill-server` on the node, then wait for the next heartbeat. Restarting the
agent (`systemctl restart proxbox-android-agent`) does the same and is safe —
the controller re-registers everything from the following heartbeat.

**Wireless ADB** devices appear with `serial` of the form `ip:5555` and
`connection: "tcp"`. They survive being unplugged, which also means a device
that went home in somebody's bag shows as `offline` rather than disappearing.

**USB permissions.** The agent runs as root, so udev rules are not usually
needed. A device stuck at `unauthorized` is not a permission problem — somebody
has to tap "Allow USB debugging" on the device's own screen once, and the UI
says exactly that.
