# Lightweight client compatibility

AFK Desk is a Java/Bedrock protocol client, not a Minecraft JVM or mod loader.
Its Java compatibility settings have these boundaries:

| Profile | Implemented behavior | Boundary |
| --- | --- | --- |
| Vanilla / plugin | Standard Java protocol | Server must accept vanilla-compatible clients |
| Fabric / Quilt | Configured brand, optional raw plugin channels, unsupported-login diagnostics | No Fabric/Quilt client mod execution, registry synchronization, or arbitrary payload codecs |
| Forge | Installed adapter's FML1/FML2/FML3 negotiation; manual or server-advertised mod lists | Matching metadata is not mod gameplay support |
| NeoForge legacy | Same legacy adapter when a legacy version/protocol is selected or detected | No claim that every legacy modpack accepts this client |
| NeoForge 1.20.4+ | Vanilla-compatible connections without incorrectly applying a legacy FML3 handshake | Modern configuration-phase negotiation is not implemented |
| Sponge / Custom | Standard protocol, explicit client brand, optional raw channels | No SpongeForge loader inference or custom protocol emulator |

The shared `assets/compatibility-capabilities.js` module supplies both renderer
descriptions and backend validation. Explicit unsupported NeoForge FML selections
produce an actionable error instead of silently installing the wrong adapter.

Optional channels are registered only after entering PLAY, and reannounced after
configuration/server transfers. This avoids sending play packets during login.
Unknown login requests retain minecraft-protocol's negative response; a bounded,
deduplicated diagnostic names the channel without logging its payload. No unknown
request receives a fabricated successful acknowledgement.
Reserved brand, registration and FML handshake codecs cannot be replaced with
raw channel declarations.

Explicit FML2/FML3 selection with an empty mod list now installs that selected
handler with upstream reflection options. Explicit FML1 obtains its list from the
server status response (through the configured proxy when enabled); if the list
is absent, configure a manual list. Fixed-version detection uses a ten-second
status timeout. Network/authentication/server acceptance still requires live tests.

## Source evidence and limitations

The installed `minecraft-protocol-forge` adapter handles `fml:loginwrapper`
login-plugin requests. It has no NeoForge configuration-payload implementation.
NeoForge's [1.20.2 NetworkConstants source](https://raw.githubusercontent.com/neoforged/NeoForge/1.20.2/src/main/java/net/neoforged/neoforge/network/NetworkConstants.java)
still identifies FML3, so that version is not blanket-classified as modern.
The [NeoForge 20.4 networking rewrite](https://neoforged.net/news/20.4networking-rework/)
and [configuration/play payload documentation](https://docs.neoforged.net/docs/1.20.4/networking/payload/)
describe the later protocol boundary. The 1.20.4 cutoff is conservative;
individual prerelease/build variants still require server-specific validation.

Local regression tests cover configuration selection, deferred channel
registration, transfers, unknown login responses and handler invocation.
They do not certify live modpack compatibility or implement mod rendering,
custom blocks/entities, server-specific mandatory payloads, or Java mod code.
