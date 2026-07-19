# Optional WAV overrides

`SoundDB` synthesizes all SFX by default. To replace a sound with a sample, drop a mono or stereo WAV here using the event name:

| File | Event |
| :--- | :--- |
| `whistle.wav` | Short referee double peep |
| `whistle_long.wav` | Half-time whistle |
| `whistle_end.wav` | Full-time whistle |
| `kick.wav` | Generic kick (legacy) |
| `pass.wav` | Short / ground pass |
| `shot.wav` | Shot |
| `lob.wav` | Long pass / GK clear |
| `header.wav` | Header contact |
| `throwin.wav` | Throw-in release |
| `touch.wav` | Soft claim / first touch |
| `bounce.wav` | Ball bounce |
| `tackle.wav` | Successful tackle / block |
| `slide.wav` | Slide start |
| `catch.wav` | GK catch (routine) |
| `save.wav` | GK save of a shot |
| `foul.wav` | Foul impact |
| `card.wav` | Card shown |
| `offside.wav` | Offside whistle pair |
| `cheer.wav` / `roar.wav` | Goal / full-time celebration |
| `ooh.wav` / `boo.wav` | Crowd reaction |
| `net.wav` | Ball in net |
| `crowd_burst.wav` | Short crowd swell |

Paths are fetched as `/assets/sounds/<name>.wav`. Missing files are ignored (synth keeps playing).
