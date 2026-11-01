"use strict"

const tls = require("tls")
const dgram = require("dgram")
const { Duplex } = require("stream")
const MumbleClient = require("mumble-client")
const mumbleStreams = require("mumble-streams")

const UdpCrypt = mumbleStreams.udpCrypto


function toBuffer(value) {
    if (!value) {
        return null
    }

    if (Buffer.isBuffer(value)) {
        return Buffer.from(value)
    }

    if (typeof value.toBuffer === "function") {
        return Buffer.from(
            value.toBuffer()
        )
    }

    if (
        value.buffer
        && Number.isInteger(value.offset)
        && Number.isInteger(value.limit)
    ) {
        return Buffer.from(
            value.buffer.slice(
                value.offset,
                value.limit
            )
        )
    }

    return Buffer.from(value)
}


class UdpVoiceStream extends Duplex {
    constructor(socket, crypt) {
        super()

        this.socket = socket
        this.crypt = crypt
        this._udpClosed = false

        socket.on(
            "message",
            packet => {
                if (
                    this._udpClosed
                    || !this.crypt.ready()
                ) {
                    return
                }

                let plain

                try {
                    plain =
                        this.crypt.decrypt(
                            packet
                        )
                } catch {
                    return
                }

                if (
                    !plain
                    || plain.length === 0
                ) {
                    return
                }

                /*
                 * We intentionally receive the UDP traffic
                 * but do not decode incoming voice.
                 *
                 * Murmur still has to transmit every packet
                 * to this client, so server/network load is
                 * realistic.
                 *
                 * The load-test bot does not need to waste
                 * CPU decoding the other test bots.
                 */
            }
        )

        socket.on(
            "error",
            err => {
                if (!this._udpClosed) {
                    this.destroy(err)
                }
            }
        )
    }


    _read() {}


    _write(
        chunk,
        encoding,
        callback
    ) {
        if (
            this._udpClosed
            || !this.crypt.ready()
        ) {
            callback()
            return
        }

        let encrypted

        try {
            encrypted =
                this.crypt.encrypt(
                    chunk
                )
        } catch (err) {
            callback(err)
            return
        }

        this.socket.send(
            encrypted,
            err => {
                callback(
                    err || null
                )
            }
        )
    }


    _destroy(
        err,
        callback
    ) {
        this._udpClosed = true

        try {
            this.socket.close()
        } catch {}

        callback(err)
    }


    sendPing() {
        if (
            this._udpClosed
            || !this.crypt.ready()
        ) {
            return
        }

        /*
         * Legacy Mumble UDP ping.
         * 0x20 = UDP ping packet type.
         * 0x00 = timestamp varint 0.
         */
        const ping =
            Buffer.from([
                0x20,
                0x00
            ])

        try {
            this.socket.send(
                this.crypt.encrypt(
                    ping
                )
            )
        } catch {}
    }
}


function connect(
    host,
    port,
    options,
    callback
) {
    const tlsOptions = {
        ...(options.tls || {}),
        host,
        port
    }

    const rejectUnauthorized =
        Object.prototype.hasOwnProperty.call(
            tlsOptions,
            "rejectUnauthorized"
        )
            ? tlsOptions.rejectUnauthorized
            : true


    const promise =
        new Promise(
            (resolve, reject) => {
                const socket =
                    tls.connect(
                        tlsOptions
                    )

                socket.once(
                    "error",
                    reject
                )

                socket.once(
                    "secureConnect",
                    () => {
                        if (
                            socket.authorized
                            || !rejectUnauthorized
                        ) {
                            resolve(socket)
                            return
                        }

                        reject(
                            new Error(
                                socket.authorizationError
                                || "TLS authorization failed"
                            )
                        )
                    }
                )
            }
        )
            .then(socket => {
                const client =
                    new MumbleClient(
                        options
                    )

                const udp =
                    dgram.createSocket(
                        "udp4"
                    )

                const crypt =
                    new UdpCrypt()

                let voiceStream = null
                let voiceConnected = false
                let pingTimer = null

                let udpReadyResolve
                let udpReadyReject


                const udpReady =
                    new Promise(
                        (resolve, reject) => {
                            udpReadyResolve =
                                resolve

                            udpReadyReject =
                                reject
                        }
                    )


                const udpTimeout =
                    setTimeout(
                        () => {
                            udpReadyReject(
                                new Error(
                                    "Timed out waiting for Mumble UDP CryptSetup"
                                )
                            )
                        },
                        10000
                    )


                udp.on(
                    "error",
                    err => {
                        if (!voiceConnected) {
                            clearTimeout(
                                udpTimeout
                            )

                            udpReadyReject(
                                err
                            )
                        }
                    }
                )


                function establishUdpVoice() {
                    if (
                        voiceConnected
                        || !crypt.ready()
                    ) {
                        return
                    }

                    voiceConnected = true

                    udp.connect(
                        port,
                        host,
                        () => {
                            voiceStream =
                                new UdpVoiceStream(
                                    udp,
                                    crypt
                                )

                            /*
                             * mumble-client normally tunnels
                             * voice through TCP.
                             *
                             * Remove that fallback listener
                             * BEFORE attaching the UDP stream,
                             * otherwise every voice packet is
                             * transmitted twice.
                             */
                            client
                                ._voiceEncoder
                                .removeAllListeners(
                                    "data"
                                )

                            client.connectVoiceStream(
                                voiceStream
                            )

                            voiceStream.sendPing()

                            pingTimer =
                                setInterval(
                                    () => {
                                        voiceStream
                                            ?.sendPing()
                                    },
                                    5000
                                )

                            client._loadTestTransport =
                                "UDP"

                            clearTimeout(
                                udpTimeout
                            )

                            udpReadyResolve()
                        }
                    )
                }


                /*
                 * mumble-client does not implement
                 * CryptSetup itself.
                 *
                 * Install the missing handler before
                 * beginning authentication.
                 */
                client._onCryptSetup =
                    payload => {
                        const key =
                            toBuffer(
                                payload?.key
                            )

                        const clientNonce =
                            toBuffer(
                                payload?.client_nonce
                            )

                        const serverNonce =
                            toBuffer(
                                payload?.server_nonce
                            )


                        /*
                         * Initial setup.
                         *
                         * Client nonce encrypts
                         * client -> server UDP.
                         *
                         * Server nonce decrypts
                         * server -> client UDP.
                         */
                        if (
                            key
                            && clientNonce
                            && serverNonce
                        ) {
                            crypt.setKey(
                                key
                            )

                            crypt.setEncryptIV(
                                clientNonce
                            )

                            crypt.setDecryptIV(
                                serverNonce
                            )

                            establishUdpVoice()
                            return
                        }


                        /*
                         * Server nonce resync.
                         */
                        if (serverNonce) {
                            crypt.setDecryptIV(
                                serverNonce
                            )

                            return
                        }


                        /*
                         * Server requested a crypto
                         * resynchronization.
                         */
                        if (
                            crypt.ready()
                            && client._send
                        ) {
                            client._send({
                                name:
                                    "CryptSetup",

                                payload: {
                                    client_nonce:
                                        crypt
                                            .getEncryptIV()
                                }
                            })
                        }
                    }


                const originalDisconnect =
                    client.disconnect
                        .bind(client)


                client.disconnect =
                    function disconnectV2() {
                        if (pingTimer) {
                            clearInterval(
                                pingTimer
                            )

                            pingTimer = null
                        }

                        try {
                            voiceStream
                                ?.destroy()
                        } catch {}

                        try {
                            udp.close()
                        } catch {}

                        return originalDisconnect()
                    }


                return Promise.all([
                    client.connectDataStream(
                        socket
                    ),

                    udpReady
                ])
                    .then(
                        () => client
                    )
            })


    if (
        typeof callback
        === "function"
    ) {
        promise.then(
            client => {
                callback(
                    null,
                    client
                )
            },

            err => {
                callback(err)
            }
        )
    }

    return promise
}


module.exports = connect

