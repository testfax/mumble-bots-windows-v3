"use strict"

/*
 * The legacy mumble-client libraries print protocol packets directly
 * to console.*. This load-test client only exposes our [BOT] lifecycle
 * messages.
 */
const originalLog = console.log.bind(console)
const originalError = console.error.bind(console)
const originalWarn = console.warn.bind(console)

function botConsoleOnly(original) {
    return (...args) => {
        const first = String(args[0] || "")

        if (first.startsWith("[BOT]")) {
            original(...args)
        }
    }
}

console.log = botConsoleOnly(originalLog)
console.error = botConsoleOnly(originalError)
console.warn = botConsoleOnly(originalWarn)

const fs = require("fs")
const { spawn } = require("child_process")
const { Transform } = require("stream")
const connect = require("./udp-connect-v2")
const codecs = require("./codecs/discordjs-codecs")

const host = process.argv[2]
const port = Number(process.argv[3])
const username = process.argv[4]
const password = process.argv[5]
const audioFile = process.argv[6] || null

if (!host || !port || !username || !password) {
    process.exit(1)
}

if (audioFile && !fs.existsSync(audioFile)) {
    console.error(`[BOT] Audio file not found ${audioFile}`)
    process.exit(1)
}

connect(
    host,
    port,
    {
        username,
        password,
        codecs,

        tls: {
            rejectUnauthorized: false
        }
    },
    (err, client) => {
        if (err) {
            console.error(
                `[BOT] Connection failed ${username}: ${
                    err?.message || err
                }`
            )
            process.exit(1)
        }

        console.log(`[BOT] Connected ${username} [UDP]`)

        let ffmpeg = null
        let shuttingDown = false

        if (audioFile) {
            const voice = client.createVoiceStream(0)

            ffmpeg = spawn(
                process.env.FFMPEG_PATH || "ffmpeg",
                [
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-re",
                    "-stream_loop",
                    "-1",
                    "-i",
                    audioFile,
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "pipe:1"
                ],
                {
                    stdio: [
                        "ignore",
                        "pipe",
                        "ignore"
                    ]
                }
            )

            const PCM_FRAME_BYTES = 3840
            let pending = Buffer.alloc(0)

            const frameStream = new Transform({
                transform(chunk, encoding, callback) {
                    pending = Buffer.concat([
                        pending,
                        chunk
                    ])

                    while (
                        pending.length >= PCM_FRAME_BYTES
                    ) {
                        this.push(
                            pending.subarray(
                                0,
                                PCM_FRAME_BYTES
                            )
                        )

                        pending =
                            pending.subarray(
                                PCM_FRAME_BYTES
                            )
                    }

                    callback()
                }
            })

            ffmpeg.stdout
                .pipe(frameStream)
                .pipe(voice)
        }

        const shutdown = () => {
            if (shuttingDown) {
                return
            }

            shuttingDown = true

            try {
                if (ffmpeg) {
                    ffmpeg.kill("SIGTERM")
                }
            } catch {}

            try {
                client.disconnect?.()
            } catch {}

            console.log(`[BOT] Disconnected ${username}`)
            process.exit(0)
        }

        process.on("SIGTERM", shutdown)
        process.on("SIGINT", shutdown)
    }
)


