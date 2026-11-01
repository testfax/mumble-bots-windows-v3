"use strict"

const http = require("http")
const fs = require("fs")
const os = require("os")
const { spawn, spawnSync } = require("child_process")
const path = require("path")

const BASE = __dirname
const PS1 = path.join(BASE, "mumble-bots.ps1")
const CONFIG_FILE = path.join(BASE, "config.json")
const HOST = "127.0.0.1"
const PORT = 8787
const DEFAULT_CONNECTION_URL = ""

let abortHandling = false


let loadtestStartInFlight = false
let loadtestStopPending = false

async function getRemoteBotLimit() {
    const config = readConfig()
    const token = String(config.apiToken || "").trim()
    const baseUrl = String(config.connectionUrl || DEFAULT_CONNECTION_URL)
        .trim().replace(/\/+$/, "")

    if (!token || !/^https:\/\/[^/]+$/i.test(baseUrl)) {
        throw new Error("HTTPS connection and token required")
    }

    const response = await fetch(
        baseUrl + "/internal/mumble-loadtest-session/connection",
        {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
            signal: AbortSignal.timeout(10000)
        }
    )

    if (!response.ok) {
        throw new Error("VPS limit unavailable (HTTP " + response.status + ")")
    }

    const data = await response.json()

    if (!Number.isSafeInteger(data.maxBots) ||
        data.maxBots < 1 || data.maxBots > 1000) {
        throw new Error("Invalid VPS Max Bots limit")
    }

    return data.maxBots
}

const LOGICAL_CPUS = Math.max(1, os.cpus().length)
const cpuSamples = new Map()


function readConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return {
            apiToken: "",
            connectionUrl: DEFAULT_CONNECTION_URL,
            audioFile: ".\\audio\\dca-atc.mp3"
        }
    }

    return JSON.parse(
        fs.readFileSync(CONFIG_FILE, "utf8")
            .replace(/^\uFEFF/, "")
    )
}


function writeConfig(config) {
    fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(config, null, 2) + "\n",
        "utf8"
    )
}

async function checkRemoteAbort() {
    if (abortHandling) {
        return
    }

    const config =
        readConfig()

    const token =
        String(
            config.apiToken || ""
        ).trim()

    if (!token) {
        return
    }

    const baseUrl = String(config.connectionUrl || DEFAULT_CONNECTION_URL).trim().replace(/\/+$/, "")
    if (!/^https?:\/\/[^/]+$/i.test(baseUrl)) {
        return
    }

    try {
        const response =
            await fetch(
                baseUrl + "/internal/mumble-loadtest-abort",
                {
                    headers: {
                        Authorization:
                            `Bearer ${token}`
                    },

                    cache: "no-store"
                }
            )

        if (!response.ok) {
            return
        }

        const data =
            await response.json()

        if (data.abort !== true) {
            return
        }

        abortHandling = true

        try {
            await runPowerShell([
                "stop"
            ])
        } catch {}

        lastAbortMessage =
            "SAFETY ABORT\n"
            + "VPS CPU MAX: "
            + Number(
                data.cpuPercent || 0
            ).toFixed(1)
            + "%\n"
            + "Threshold: "
            + Number(
                data.thresholdPercent || 0
            ).toFixed(1)
            + "% for "
            + Number(
                data.sustainedSeconds || 0
            )
            + " seconds\n"
            + "All load-test bots stopped automatically."

    } catch {
        // Ignore temporary polling/network failures.
    } finally {
        abortHandling = false
    }
}


let lastAbortMessage = ""


function json(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    })

    res.end(JSON.stringify(data))
}


function getBots() {
    try {
        const command = [
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
            "| Where-Object { $_.CommandLine -like '*connect-one.js*' }",
            "| Select-Object ProcessId,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime",
            "| ConvertTo-Json -Compress"
        ].join(" ")

        const result = spawnSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-Command",
                command
            ],
            {
                encoding: "utf8",
                windowsHide: true
            }
        )

        const output =
            String(result.stdout || "").trim()

        if (!output) {
            cpuSamples.clear()
            return []
        }

        const parsed = JSON.parse(output)

        const rows =
            Array.isArray(parsed)
                ? parsed
                : [parsed]

        const now = Date.now()
        const livePids = new Set()

        const bots =
            rows.map(row => {
                const pid =
                    Number(row.ProcessId)

                livePids.add(pid)

                const commandLine =
                    String(row.CommandLine || "")

                const match =
                    commandLine.match(/LoadBot-\d+/i)

                const totalCpuSeconds =
                    (
                        Number(row.KernelModeTime || 0)
                        + Number(row.UserModeTime || 0)
                    )
                    / 10000000

                const previous =
                    cpuSamples.get(pid)

                let cpuPercent = 0

                if (previous) {
                    const elapsedSeconds =
                        (now - previous.time) / 1000

                    const cpuSecondsUsed =
                        totalCpuSeconds
                        - previous.cpuSeconds

                    if (
                        elapsedSeconds > 0
                        && cpuSecondsUsed >= 0
                    ) {
                        cpuPercent =
                            (
                                cpuSecondsUsed
                                / elapsedSeconds
                                / LOGICAL_CPUS
                            )
                            * 100
                    }
                }

                cpuSamples.set(
                    pid,
                    {
                        time: now,
                        cpuSeconds: totalCpuSeconds
                    }
                )

                return {
                    pid,

                    name:
                        match
                            ? match[0]
                            : "LoadBot",

                    ramMb:
                        Math.round(
                            (
                                Number(
                                    row.WorkingSetSize || 0
                                )
                                / 1048576
                            )
                            * 100
                        )
                        / 100,

                    cpuPercent:
                        Math.round(
                            cpuPercent * 100
                        )
                        / 100
                }
            })

        for (const pid of cpuSamples.keys()) {
            if (!livePids.has(pid)) {
                cpuSamples.delete(pid)
            }
        }

        return bots

    } catch {
        return []
    }
}


function runPowerShell(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "powershell.exe",
            [
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                PS1,
                ...args
            ],
            {
                cwd: BASE,
                windowsHide: true
            }
        )

        let stdout = ""
        let stderr = ""

        child.stdout.on("data", data => {
            stdout += data.toString()
        })

        child.stderr.on("data", data => {
            stderr += data.toString()
        })

        child.on("error", reject)

        child.on("exit", code => {
            if (code !== 0) {
                reject(
                    new Error(
                        stderr.trim()
                        || stdout.trim()
                        || `PowerShell exited ${code}`
                    )
                )
                return
            }

            resolve(stdout.trim())
        })
    })
}


function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = ""

        req.on("data", chunk => {
            body += chunk
        })

        req.on("end", () => {
            try {
                resolve(
                    body
                        ? JSON.parse(body)
                        : {}
                )
            } catch {
                reject(
                    new Error("Invalid request")
                )
            }
        })
    })
}


const PAGE = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Mumble Bot Controller</title>

<style>
body {
    font-family: Arial, sans-serif;
    background: #0b1220;
    color: #e5e7eb;
    margin: 0;
}

main {
    max-width: 900px;
    margin: 40px auto;
    padding: 0 16px;
}

.card {
    background: #182230;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 22px;
    margin-bottom: 18px;
}

.row {
    display: flex;
    gap: 14px;
    align-items: end;
    flex-wrap: wrap;
}

label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-weight: bold;
}

input {
    padding: 10px;
    background: #111827;
    color: white;
    border: 1px solid #475569;
    border-radius: 7px;
}

.number {
    width: 110px;
    appearance: textfield;
    -moz-appearance: textfield;
}

.number::-webkit-outer-spin-button,
.number::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
}

.number-stepper {
    display: inline-flex;
    align-items: stretch;
    gap: 8px;
}

.number-stepper input {
    width: 72px;
    text-align: center;
}

.step-btn {
    width: 34px;
    min-width: 34px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #111827;
    color: white;
    border: 1px solid #475569;
    border-radius: 7px;
    font-size: 22px;
    font-weight: bold;
    line-height: 1;
    cursor: pointer;
}

.step-btn:hover {
    background: #1f2937;
}

.step-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

.token {
    width: 560px;
    max-width: 90vw;
}

button {
    padding: 11px 18px;
    border: 0;
    border-radius: 7px;
    color: white;
    font-weight: bold;
    cursor: pointer;
}

.start { background: #16a34a; }
.stop { background: #dc2626; }

.refresh,
.save {
    background: #2563eb;
}

.clear {
    background: #b45309;
}

.status {
    font-size: 28px;
    font-weight: bold;
}

.metrics {
    margin-top: 10px;
    margin-bottom: 12px;
}

.bot {
    padding: 7px 0;
    border-bottom: 1px solid #334155;
}

#message,
#tokenMessage {
    margin-top: 15px;
    white-space: pre-wrap;
}
#urlMessage,
#tokenMessage {
    margin-top: 12px;
    min-height: 20px;
    font-size: 14px;
    font-weight: 600;
    white-space: pre-wrap;
}

.save-feedback {
    display: inline-block;
    padding: 9px 12px;
    border-radius: 6px;
}

.save-feedback.pending {
    color: #facc15;
    background: rgba(250, 204, 21, 0.12);
}

.save-feedback.success {
    color: #4ade80;
    background: rgba(74, 222, 128, 0.12);
}

.save-feedback.error {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
}

button:disabled {
    opacity: 0.55;
    cursor: wait;
}
</style>
</head>

<body>
<main>

<h1>Mumble Bot Controller</h1>

<div class="card">

<h2>Connection URL</h2>
<div class="row">
<label>
URL
<div class="row" style="align-items:center;gap:8px">
<input
    id="connectionUrl"
    class="token"
    type="text"
    autocomplete="off"
    spellcheck="false"
    pattern="[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?"
    style="min-width:0;width:30ch;max-width:100%;flex:0 1 30ch"
>
<span style="white-space:nowrap">.elitepilotslounge.com</span>
</div>
</label>
<button class="save" onclick="return saveControllerSetting(this, 'url')">Save URL</button>
</div>
<div id="urlMessage"></div>

<h2>Access Token</h2>

<div class="row">

<label>
Token
<input
    id="token"
    class="token"
    type="text"
    autocomplete="off"
>
</label>

<button class="save" onclick="return saveControllerSetting(this, 'token')">
Save Token
</button>

<button class="clear" onclick="clearToken()">
Clear Token
</button>

</div>

<div id="tokenMessage"></div>

</div>


<div class="card">

<div class="row">

<label>
Bots
<div class="number-stepper">
<button type="button" class="step-btn" onclick="return stepNumberInput('count', -1)">−</button>
<input
    id="count"
    class="number"
    type="number"
    min="1"
    value="10"
>
<button type="button" class="step-btn" onclick="return stepNumberInput('count', 1)">+</button>
</div>
</label>

<label>
Talkers
<div class="number-stepper">
<button type="button" class="step-btn" onclick="return stepNumberInput('talkers', -1)">−</button>
<input
    id="talkers"
    class="number"
    type="number"
    min="0"
    value="2"
>
<button type="button" class="step-btn" onclick="return stepNumberInput('talkers', 1)">+</button>
</div>
</label>

<label>
Start delay (ms)
<input
    id="delay"
    class="number"
    type="number"
    min="0"
    value="250"
>
</label>

<button class="start" onclick="startBots()">
Start Bots
</button>

<button class="stop" onclick="stopBots()">
Stop All
</button>

<button class="refresh" onclick="refreshStatus()">
Refresh
</button>

</div>

<div id="maxBotsMessage" role="status" aria-live="polite" style="color:#facc15;margin-top:8px"></div>
<div id="message"></div>

</div>


<div class="card">

<div class="status">
Running:
<span id="running">0</span>
</div>

<div class="metrics">
Total RAM:
<strong>
<span id="totalRam">0.00</span> MB
</strong>

&nbsp;&nbsp;

Current CPU:
<strong>
<span id="totalCpu">0.00</span>%
</strong>

&nbsp;&nbsp;

Avg Client RAM:
<strong>
<span id="avgRam">0.00</span> MB
</strong>

&nbsp;&nbsp;

Avg Client CPU:
<strong>
<span id="avgCpu">0.00</span>%
</strong>
</div>

</div>

</main>


<script>

function showSaveFeedback(elementId, message, state) {
    const element = document.getElementById(elementId)
    if (!element) return

    element.textContent = message
    element.className = "save-feedback " + state
    element.setAttribute("role", "status")
    element.setAttribute("aria-live", "polite")
}

async function performSave(button, messageId, action, successMessage) {
    if (button && button.disabled) return

    if (button) button.disabled = true

    showSaveFeedback(messageId, "Saving...", "pending")

    try {
        await action()
        showSaveFeedback(messageId, successMessage, "success")
    } catch (err) {
        showSaveFeedback(
            messageId,
            "Save failed: " + (err.message || String(err)),
            "error"
        )
    } finally {
        if (button) button.disabled = false
    }
}


async function requestJson(url, options) {
    const response =
        await fetch(url, options)

    const data =
        await response.json()

    if (
        !response.ok
        || data.success === false
    ) {
        throw new Error(
            data.error
            || "Request failed"
        )
    }

    return data
}


async function loadToken() {
    try {
        const response = await fetch("/api/config", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to read config.json")

        const config = await response.json()

        document.getElementById("connectionUrl").value =
            String(config.connectionUrl || "")
                .replace("https://", "")
                .replace(".elitepilotslounge.com", "")

        document.getElementById("token").value =
            String(config.apiToken || "")

    } catch (error) {
        console.error("Config loading failed:", error)
    }
}
async function clearToken() {
    try {
        await requestJson(
            "/api/token/clear",
            {
                method: "POST"
            }
        )

        document.getElementById(
            "token"
        ).value = ""

        document.getElementById(
            "tokenMessage"
        ).textContent =
            "Token cleared."

    } catch (err) {
        document.getElementById(
            "tokenMessage"
        ).textContent =
            err.message
    }
}

function clampInteger(value, minimum, maximum) {
    let next = Number(value)

    if (!Number.isFinite(next)) {
        next = minimum
    }

    next = Math.round(next)

    if (Number.isFinite(minimum)) {
        next = Math.max(minimum, next)
    }

    if (Number.isFinite(maximum)) {
        next = Math.min(maximum, next)
    }

    return next
}

function enforceBotTalkerBounds(forceBotsToMax = false) {
    const botInput = document.getElementById("count")
    const talkerInput = document.getElementById("talkers")

    if (!botInput || !talkerInput) return

    const botMinimum = Math.max(1, Number(botInput.min) || 1)
    const configuredMaximum = Number(botInput.max)
    const botMaximum =
        Number.isFinite(configuredMaximum) &&
        configuredMaximum >= botMinimum
            ? configuredMaximum
            : 1000

    let botCount = clampInteger(
        botInput.value,
        botMinimum,
        botMaximum
    )

    if (
        forceBotsToMax &&
        Number.isFinite(configuredMaximum) &&
        configuredMaximum >= botMinimum
    ) {
        botCount = configuredMaximum
    }

    botInput.value = String(botCount)
    talkerInput.max = String(botCount)

    const talkerMinimum = Math.max(0, Number(talkerInput.min) || 0)
    const talkerCount = clampInteger(
        talkerInput.value,
        talkerMinimum,
        botCount
    )

    talkerInput.value = String(talkerCount)
}

function stepNumberInput(inputId, delta) {
    const input = document.getElementById(inputId)
    if (!input || input.disabled) return false

    const minimum =
        inputId === "count"
            ? Math.max(1, Number(input.min) || 1)
            : Math.max(0, Number(input.min) || 0)

    const rawMaximum = Number(input.max)
    const maximum =
        Number.isFinite(rawMaximum) &&
        rawMaximum >= minimum
            ? rawMaximum
            : 1000

    const next = clampInteger(
        Number(input.value) + delta,
        minimum,
        maximum
    )

    input.value = String(next)
    enforceBotTalkerBounds(false)
    return false
}

function initializeCustomNumberInputs() {
    ["count", "talkers"].forEach(function (inputId) {
        const input = document.getElementById(inputId)
        if (!input || input.dataset.stepperBound === "1") return

        input.dataset.stepperBound = "1"

        input.addEventListener("input", function () {
            enforceBotTalkerBounds(false)
        })

        input.addEventListener("blur", function () {
            enforceBotTalkerBounds(false)
        })
    })

    enforceBotTalkerBounds(false)
}

async function refreshStatus() {
    try {
        const data =
            await requestJson(
                "/api/status"
            )

        const limitMessage = document.getElementById("maxBotsMessage")
        const botInput = document.getElementById("count")
        const talkerInput = document.getElementById("talkers")

        if (Number.isSafeInteger(data.maxBots)) {
            botInput.max = String(data.maxBots)
            talkerInput.max = String(data.maxBots)
            enforceBotTalkerBounds(true)

            const atLimit = Number(botInput.value) >= data.maxBots ||
                Number(talkerInput.value) >= data.maxBots ||
                (data.bots || []).length >= data.maxBots

            limitMessage.textContent = atLimit
                ? "Maximum allowed bots reached: " + data.maxBots
                : "Max Bots: " + data.maxBots
        } else {
            limitMessage.textContent =
                "VPS limit unavailable — starting disabled"
        }
        const bots =
            Array.isArray(data.bots)
                ? data.bots
                : []

        updateLoadtestBotLimits(data.maxBots, bots.length)

        if (data.maxBotsError) {
            const quotaWarning = document.getElementById("maxBotsMessage")
            if (quotaWarning) {
                quotaWarning.textContent =
                    "VPS Max Bots unavailable: " + data.maxBotsError
            }
        }

        document.getElementById(
            "running"
        ).textContent =
            bots.length

        const totalRam =
            bots.reduce(
                (sum, bot) => {
                    return (
                        sum
                        + Number(
                            bot.ramMb
                            || 0
                        )
                    )
                },
                0
            )

        const totalCpu =
            bots.reduce(
                (sum, bot) => {
                    return (
                        sum
                        + Number(
                            bot.cpuPercent
                            || 0
                        )
                    )
                },
                0
            )

        document.getElementById(
            "totalRam"
        ).textContent =
            totalRam.toFixed(2)

        document.getElementById(
            "totalCpu"
        ).textContent =
            totalCpu.toFixed(2)

        const avgRam =
            bots.length > 0
                ? totalRam / bots.length
                : 0

        const avgCpu =
            bots.length > 0
                ? totalCpu / bots.length
                : 0

        document.getElementById(
            "avgRam"
        ).textContent =
            avgRam.toFixed(2)

        document.getElementById(
            "avgCpu"
        ).textContent =
            avgCpu.toFixed(2)

        if (data.abortMessage) {
            document.getElementById(
                "message"
            ).textContent =
                data.abortMessage
        }

    } catch (err) {
        document.getElementById(
            "message"
        ).textContent =
            err.message
    }
}


let loadtestMaxBots = null
let loadtestRunningBots = 0

function updateLoadtestBotLimits(maxBots, runningBots) {
    loadtestMaxBots =
        Number.isSafeInteger(maxBots) &&
        maxBots >= 1 &&
        maxBots <= 1000
            ? maxBots
            : null

    loadtestRunningBots =
        Number.isSafeInteger(runningBots) && runningBots >= 0
            ? runningBots
            : 0

    const botsInput = document.getElementById("count")
    const talkersInput = document.getElementById("talkers")
    const warning = document.getElementById("maxBotsMessage")
    const start = document.querySelector("button.start")

    if (!botsInput || !talkersInput || !warning) return

    const available = loadtestMaxBots === null
        ? 0
        : Math.max(0, loadtestMaxBots - loadtestRunningBots)

    const bots = Number(botsInput.value)
    const talkers = Number(talkersInput.value)

    botsInput.max = String(available)
    talkersInput.max = String(Math.max(0, bots))

    const valid =
        loadtestMaxBots !== null &&
        Number.isSafeInteger(bots) &&
        bots >= 1 &&
        bots <= available &&
        Number.isSafeInteger(talkers) &&
        talkers >= 0 &&
        talkers <= bots

    if (loadtestMaxBots === null) {
        warning.textContent = "VPS Max Bots limit unavailable."
    } else if (available === 0 || bots > available) {
        warning.textContent =
            "Maximum allowed bots reached: " + loadtestMaxBots +
            " (" + available + " available)"
    } else if (talkers > bots || talkers < 0) {
        warning.textContent =
            "Talkers cannot exceed the requested bot count."
    } else {
        warning.textContent =
            "Max Bots: " + loadtestMaxBots +
            " | Available: " + available
    }

    if (start) {
        start.disabled = !valid
    }
}

document.getElementById("count").addEventListener("input", () => {
    updateLoadtestBotLimits(loadtestMaxBots, loadtestRunningBots)
})

document.getElementById("talkers").addEventListener("input", () => {
    updateLoadtestBotLimits(loadtestMaxBots, loadtestRunningBots)
})

async function startBots() {
    try {
        const count =
            Number(
                document.getElementById(
                    "count"
                ).value
            )

        const talkers =
            Number(
                document.getElementById(
                    "talkers"
                ).value
            )

        const delayMs =
            Number(
                document.getElementById(
                    "delay"
                ).value
            )

        document.getElementById(
            "message"
        ).textContent =
            "Starting..."

        const data =
            await requestJson(
                "/api/start",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            count,
                            talkers,
                            delayMs
                        })
                }
            )

        document.getElementById(
            "message"
        ).textContent =
            data.output
            || "Started."

        await refreshStatus()

    } catch (err) {
        document.getElementById(
            "message"
        ).textContent =
            err.message
    }
}


async function stopBots() {
    try {
        document.getElementById(
            "message"
        ).textContent =
            "Stopping..."

        const data =
            await requestJson(
                "/api/stop",
                {
                    method: "POST"
                }
            )

        document.getElementById(
            "message"
        ).textContent =
            data.output
            || "Stopped."

        await refreshStatus()

    } catch (err) {
        document.getElementById(
            "message"
        ).textContent =
            err.message
    }
}


updateLoadtestBotLimits(null, 0)
loadToken()
refreshStatus()

setInterval(
    refreshStatus,
    3000
)

async function saveControllerSetting(button, type) {
    if (button.disabled) return false;

    const isUrl = type === "url";
    const originalLabel = button.textContent;
    const input = document.getElementById(
        isUrl ? "connectionUrl" : "token"
    );

    let feedback = button.nextElementSibling;

    if (!feedback ||
        !feedback.classList.contains("controller-save-feedback")) {
        feedback = document.createElement("span");
        feedback.className = "controller-save-feedback";
        feedback.style.marginLeft = "12px";
        feedback.style.fontWeight = "bold";
        feedback.style.fontSize = "14px";
        feedback.style.display = "inline-block";
        button.insertAdjacentElement("afterend", feedback);
    }

    const show = (message, color) => {
        feedback.textContent = message;
        feedback.style.color = color;
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
    };

    button.disabled = true;
    button.textContent = "Saving...";
    show("Saving...", "#facc15");

    try {
        if (!input) {
            throw new Error("Input field not found.");
        }

        const value = input.value.trim();
        let endpoint;
        let payload;

        if (isUrl) {
            const subdomain = value.toLowerCase();

            if (
                !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain) ||
                subdomain.length > 63
            ) {
                throw new Error("Enter a valid subdomain.");
            }

            endpoint = "/api/connection-url";
            payload = { url: subdomain };
        } else {
            endpoint = "/api/token";
            payload = { token: value };
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const raw = await response.text();
        let data;

        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(
                "Server returned an invalid response (HTTP " +
                response.status + ")."
            );
        }

        if (!response.ok || data.success === false) {
            throw new Error(
                data.error ||
                "HTTP " + response.status
            );
        }

        if (isUrl) {
            input.value = value.toLowerCase();
        }

        show(
            isUrl
                ? "Connection URL saved successfully."
                : "Access Token saved successfully.",
            "#4ade80"
        );

    } catch (error) {
        show(
            "Save failed: " + (error.message || String(error)),
            "#f87171"
        );
    } finally {
        button.disabled = false;
        button.textContent = originalLabel;
    }

    return false;
}

</script>

<!-- MUMBLE_SAVE_BUTTON_FEEDBACK_V2 -->
<style>
.mumble-save-success {
    background: #16a34a !important;
    border-color: #16a34a !important;
    color: white !important;
}
.mumble-save-error {
    background: #dc2626 !important;
    border-color: #dc2626 !important;
    color: white !important;
}
.mumble-save-pending {
    opacity: 0.75 !important;
}
.mumble-save-status {
    display: block;
    margin-top: 8px;
    font-size: 13px;
}
</style>

<script>
(function () {
    "use strict";

    function findButton(label) {
        return Array.from(document.querySelectorAll("button"))
            .find(function (button) {
                return button.textContent.trim() === label;
            });
    }

    function setupButton(label, inputId, endpoint, property, isUrl) {
        const button = findButton(label);
        if (!button) return;

        // Disconnect all previously installed inline click handlers.
        button.removeAttribute("onclick");
        button.onclick = null;

        const originalText = button.textContent.trim();

        const status = document.createElement("div");
        status.className = "mumble-save-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        button.insertAdjacentElement("afterend", status);

        let resetTimer = null;

        button.addEventListener("click", async function (event) {
            event.preventDefault();
            event.stopPropagation();

            if (button.disabled) return;

            if (resetTimer !== null) {
                clearTimeout(resetTimer);
                resetTimer = null;
            }

            const input = document.getElementById(inputId);

            button.classList.remove(
                "mumble-save-success",
                "mumble-save-error"
            );

            button.classList.add("mumble-save-pending");
            button.textContent = "Saving...";
            button.disabled = true;
            status.textContent = "";

            // Allow the browser to paint the Saving state.
            await new Promise(function (resolve) {
                requestAnimationFrame(resolve);
            });

            let success = false;

            try {
                if (!input) {
                    throw new Error("Input not found: " + inputId);
                }

                let value = input.value.trim();

                if (isUrl) {
                    value = value.toLowerCase();

                    if (
                        value.length > 63 ||
                        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
                    ) {
                        throw new Error(
                            "Enter only a valid subdomain."
                        );
                    }
                }

                const payload = {};
                payload[property] = value;

                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                });

                const raw = await response.text();
                let result;

                try {
                    result = JSON.parse(raw);
                } catch (error) {
                    throw new Error(
                        "Invalid server response (HTTP " +
                        response.status + ")"
                    );
                }

                if (
                    !response.ok ||
                    !result ||
                    result.success !== true
                ) {
                    throw new Error(
                        (result && result.error) ||
                        "Server returned HTTP " + response.status
                    );
                }

                if (isUrl) {
                    input.value = value;
                }

                success = true;

            } catch (error) {
                status.textContent =
                    "Save failed: " +
                    (error.message || String(error));
                status.style.color = "#f87171";
            }

            button.classList.remove("mumble-save-pending");
            button.classList.add(
                success
                    ? "mumble-save-success"
                    : "mumble-save-error"
            );

            button.textContent = success ? "Saved!" : "Failed!";

            resetTimer = setTimeout(function () {
                button.classList.remove(
                    "mumble-save-success",
                    "mumble-save-error",
                    "mumble-save-pending"
                );

                button.textContent = originalText;
                button.disabled = false;
                resetTimer = null;
            }, 1000);
        });
    }

    function initializeSaveButtons() {
        setupButton(
            "Save URL",
            "connectionUrl",
            "/api/connection-url",
            "url",
            true
        );

        setupButton(
            "Save Token",
            "token",
            "/api/token",
            "token",
            false
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            initializeSaveButtons,
            { once: true }
        );
    } else {
        initializeSaveButtons();
    }
})();
</script>
<!-- MUMBLE_START_BOTS_REPAIR_V1 -->
<script>
(function () {
    "use strict";

    const button = document.querySelector(
        'button[onclick="startBots()"]'
    );

    const message = document.getElementById("message");

    if (!button || !message) {
        console.error("Start Bots controls not found.");
        return;
    }

    // Replace the original click handler.
    button.removeAttribute("onclick");
    button.onclick = null;

    const originalText = button.textContent.trim();
    const originalBackground = getComputedStyle(button).backgroundColor;

    let active = false;

    function setMessage(text, color) {
        message.textContent = text;
        message.style.color = color;
        message.style.whiteSpace = "pre-wrap";
    }

    function showResult(success, text) {
        button.textContent = success ? "Started!" : "Failed!";
        button.style.backgroundColor =
            success ? "#16a34a" : "#dc2626";

        setMessage(
            text,
            success ? "#4ade80" : "#f87171"
        );

        setTimeout(function () {
            button.textContent = originalText;
            button.style.backgroundColor = originalBackground;
            button.disabled = false;
            active = false;
        }, 1000);
    }

    button.addEventListener("click", async function (event) {
        event.preventDefault();
        event.stopPropagation();

        if (active) return;

        active = true;
        button.disabled = true;
        button.textContent = "Starting...";
        button.style.backgroundColor = "#ca8a04";

        setMessage("Starting bots...", "#facc15");

        try {
            const count = Number(
                document.getElementById("count").value
            );

            const talkers = Number(
                document.getElementById("talkers").value
            );

            const delayMs = Number(
                document.getElementById("delay").value
            );

            if (!Number.isInteger(count) ||
                count < 1 || count > 1000) {
                throw new Error("Bot count must be between 1 and 1000.");
            }

            if (!Number.isInteger(talkers) ||
                talkers < 0 || talkers > count) {
                throw new Error("Invalid talker count.");
            }

            if (!Number.isInteger(delayMs) ||
                delayMs < 0 || delayMs > 60000) {
                throw new Error("Invalid start delay.");
            }

            const response = await fetch("/api/start", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    count: count,
                    talkers: talkers,
                    delayMs: delayMs
                })
            });

            const raw = await response.text();

            let result;

            try {
                result = JSON.parse(raw);
            } catch {
                throw new Error(
                    "Invalid server response (HTTP " +
                    response.status + ")."
                );
            }

            if (!response.ok || result.success !== true) {
                throw new Error(
                    result.error ||
                    "Start request failed (HTTP " +
                    response.status + ")."
                );
            }

            showResult(
                true,
                result.output || "Bot start command completed."
            );

            // Update statistics independently of the old handler.
            try {
                const statusResponse = await fetch("/api/status");

                if (statusResponse.ok) {
                    const status = await statusResponse.json();

                    if (Array.isArray(status.bots)) {
                        const running =
                            document.getElementById("running");

                        if (running) {
                            running.textContent = status.bots.length;
                        }
                    }
                }
            } catch (statusError) {
                console.warn(
                    "Status refresh failed:",
                    statusError
                );
            }

        } catch (error) {
            showResult(
                false,
                "Start Bots failed: " +
                (error.message || String(error))
            );
        }
    });
})();
</script>
</body>
</html>`


const server =
    http.createServer(
        async (req, res) => {
            try {
                if (
                    req.method === "GET"
                    && req.url === "/"
                ) {
                    res.writeHead(
                        200,
                        {
                            "Content-Type":
                                "text/html; charset=utf-8",

                            "Cache-Control":
                                "no-store"
                        }
                    )

                    const config = readConfig()

                    const escapeHtml = value =>
                        String(value ?? "")
                            .replace(/&/g, "&amp;")
                            .replace(/"/g, "&quot;")
                            .replace(/</g, "&lt;")
                            .replace(/>/g, "&gt;")
                            .replace(/'/g, "&#39;")

                    const subdomain = String(config.connectionUrl || "")
                        .replace(/^https?:\/\//i, "")
                        .replace(/\.elitepilotslounge\.com\/?$/i, "")

                    const html = PAGE
                        .replace(
                            'id="connectionUrl"',
                            'id="connectionUrl" value="' + escapeHtml(subdomain) + '"'
                        )
                        .replace(
                            'id="token"',
                            'id="token" value="' + escapeHtml(config.apiToken) + '"'
                        )

                    res.end(html)
                    return
                }


                if (
                    req.method === "GET"
                    && req.url === "/api/config"
                ) {
                    const config =
                        readConfig()

                    json(
                        res,
                        200,
                        {
                            success: true,

                            apiToken:
                                String(
                                    config.apiToken
                                    || ""
                                ),
                            connectionUrl:
                                String(config.connectionUrl || DEFAULT_CONNECTION_URL)
                        }
                    )

                    return
                }


                if (
                    req.method === "POST"
                    && req.url === "/api/connection-url"
                ) {
                    const body = await readBody(req)
                    const value = String(body.url || "").trim().toLowerCase()

                    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) ||
                        value.length > 63) {
                        json(res, 400, {
                            success: false,
                            error: "Enter a valid server subdomain."
                        })
                        return
                    }

                    const connectionUrl = "https://" + value + ".elitepilotslounge.com"
                    const config = readConfig()
                    config.connectionUrl = connectionUrl
                    writeConfig(config)
                    json(res, 200, { success: true, connectionUrl })
                    return
                }

                if (
                    req.method === "POST"
                    && req.url === "/api/token"
                ) {
                    const body =
                        await readBody(req)

                    const token =
                        String(
                            body.token
                            || ""
                        ).trim()

                    const config =
                        readConfig()

                    config.apiToken =
                        token

                    delete config.serverSlug
                    delete config.vpsBaseUrl
                    delete config.mumbleHost

                    writeConfig(config)

                    json(
                        res,
                        200,
                        {
                            success: true
                        }
                    )

                    return
                }


                if (
                    req.method === "POST"
                    && req.url === "/api/token/clear"
                ) {
                    const config =
                        readConfig()

                    config.apiToken = ""

                    delete config.serverSlug
                    delete config.vpsBaseUrl
                    delete config.mumbleHost

                    writeConfig(config)

                    json(
                        res,
                        200,
                        {
                            success: true
                        }
                    )

                    return
                }


                if (
                    req.method === "GET"
                    && req.url === "/api/status"
                ) {
                    json(
                        res,
                        200,
                        {
                            success: true,
                            ...await getRemoteBotLimit()
    .then(maxBots => ({
        maxBots,
        maxBotsError: null
    }))
    .catch(error => ({
        maxBots: null,
        maxBotsError: String(error.message || error).slice(0, 200)
    })),                            bots: getBots(),
                            abortMessage:
                                lastAbortMessage
                        }
                    )

                    return
                }


                if (
                    req.method === "POST"
                    && req.url === "/api/start"
                ) {
                    const body =
                        await readBody(req)

                    const count =
                        Number(
                            body.count
                        )

                    const talkers =
                        Number(
                            body.talkers
                        )

                    const delayMs =
                        Number(
                            body.delayMs
                        )

                    if (
                        !Number.isInteger(count)
                        || count < 1
                        || count > 1000
                    ) {
                        throw new Error(
                            "Invalid bot count"
                        )
                    }

                    if (
                        !Number.isInteger(talkers)
                        || talkers < 0
                        || talkers > count
                    ) {
                        throw new Error(
                            "Invalid talker count"
                        )
                    }

                    if (
                        !Number.isInteger(delayMs)
                        || delayMs < 0
                        || delayMs > 60000
                    ) {
                        throw new Error(
                            "Invalid start delay"
                        )
                    }

                    const maxBots = await getRemoteBotLimit()

                    if (getBots().length + count > maxBots) {
                        return json(res, 409, {
                            success: false,
                            error: "Maximum allowed bots reached: " + maxBots
                        })
                    }
                    if (loadtestStartInFlight || loadtestStopPending) {
                        return json(res, 409, {
                            success: false,
                            error: "A bot launch is already in progress."
                        })
                    }

                    loadtestStartInFlight = true
                    let output
                    try {
                        output = await runPowerShell([
                                                    "start",
                                                    String(count),
                        
                                                    "-Talkers",
                                                    String(talkers),
                        
                                                    "-DelayMs",
                                                    String(delayMs)
                                                ])
                    } finally {
                        loadtestStartInFlight = false
                    }

                    json(
                        res,
                        200,
                        {
                            success: true,
                            output
                        }
                    )

                    return
                }


                if (
                    req.method === "POST"
                    && req.url === "/api/stop"
                ) {
                    if (loadtestStopPending) {
                        return json(res, 409, {
                            success: false,
                            error: "Stop already in progress."
                        })
                    }

                    loadtestStopPending = true
                    let output

                    try {
                        const stopWaitDeadline = Date.now() + 30000

                        while (loadtestStartInFlight) {
                            if (Date.now() >= stopWaitDeadline) {
                                throw new Error(
                                    "Stop could not begin because bot startup is still in progress."
                                )
                            }

                            await new Promise(resolve => setTimeout(resolve, 100))
                        }

                        output = await runPowerShell(["stop"])
                    } finally {
                        loadtestStopPending = false
                    }

                    json(
                        res,
                        200,
                        {
                            success: true,
                            output
                        }
                    )

                    return
                }


                json(
                    res,
                    404,
                    {
                        success: false,
                        error: "Not found"
                    }
                )

            } catch (err) {
                json(
                    res,
                    500,
                    {
                        success: false,
                        error: err.message
                    }
                )
            }
        }
    )


server.listen(
    PORT,
    HOST,
    () => {
        console.log(
            "Mumble Bot Controller running:"
        )

        console.log(
            `http://${HOST}:${PORT}`
        )
    }
)


setInterval(
    checkRemoteAbort,
    1000
)

checkRemoteAbort()
