"use strict"

const { Transform } = require("stream")
const { OpusEncoder } = require("@discordjs/opus")

const celt = []
const opus = true


function float32ToInt16(pcm) {
    const output = Buffer.allocUnsafe(
        pcm.length * 2
    )

    for (let i = 0; i < pcm.length; i++) {
        let value = pcm[i]

        value = Math.max(
            -1,
            Math.min(1, value)
        )

        const sample =
            value < 0
                ? value * 32768
                : value * 32767

        output.writeInt16LE(
            Math.round(sample),
            i * 2
        )
    }

    return output
}


function int16ToFloat32(buffer) {
    const samples =
        Math.floor(buffer.length / 2)

    const output =
        new Float32Array(samples)

    for (let i = 0; i < samples; i++) {
        const value =
            buffer.readInt16LE(i * 2)

        output[i] =
            value < 0
                ? value / 32768
                : value / 32767
    }

    return output
}


class EncoderStream extends Transform {
    constructor() {
        super({
            objectMode: true
        })

        this.encoder = null
    }

    _transform(chunk, encoding, callback) {
        try {
            if (!this.encoder) {
                this.encoder =
                    new OpusEncoder(
                        48000,
                        chunk.numberOfChannels
                    )
            }

            const pcm =
                float32ToInt16(
                    chunk.pcm
                )

            const frame =
                this.encoder.encode(pcm)

            if (!this.frameCount) {
                this.frameCount = 0
            }

            this.frameCount += 1

            if (
                this.frameCount <= 5
                || this.frameCount % 100 === 0
            ) {

            }

            callback(
                null,
                {
                    target: chunk.target,
                    codec: "Opus",
                    frame,
                    position: chunk.position
                }
            )

        } catch (err) {
            callback(err)
        }
    }
}


class DecoderStream extends Transform {
    constructor() {
        super({
            objectMode: true
        })
    }

    _transform(chunk, encoding, callback) {
        /*
         * Load-test bots intentionally do not decode incoming voice.
         *
         * They only need to maintain the Mumble connection and,
         * when configured as talkers, transmit audio.
         *
         * Discarding incoming audio prevents every bot from decoding
         * every other talker and avoids packet-loss/null-frame crashes.
         */
        callback()
    }
}

function getDuration(codec, buffer) {
    if (codec === "Opus") {
        return 20
    }

    return 1
}


function createEncoderStream(codec) {
    if (codec === "Opus") {
        return new EncoderStream()
    }

    throw new Error(
        `Unsupported codec: ${codec}`
    )
}


function createDecoderStream(user) {
    return new DecoderStream()
}


module.exports = {
    celt,
    opus,
    getDuration,
    createEncoderStream,
    createDecoderStream
}

