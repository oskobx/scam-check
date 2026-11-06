# 🛡️ Scam Check

**A FaceTime number seniors can call whenever something feels like a scam.**

Built at the AI for Social Good Hackathon at West Valley College (Nov 6, 2026) for the
**Senior Fraud and Scams** track with [SASCC](https://sascc.org), and for Chert's **Best Use of FaceTime** prize.

## The problem

In the FBI's report on 2025, adults 60+ filed about 14% of AI-related fraud complaints but took about 39%
of the losses. Voice-cloned "grandparent" calls, fake IRS letters and
"your package is on hold" texts are getting harder to spot. Most victims never report it, and many don't
have someone to ask "is this real?" in the moment.

## What it does

A senior simply **FaceTimes Scam Check**, an app they already know, with nothing to install. Then they can:

- **Hold up** a suspicious letter, email, text or bill to the camera, or
- **Describe what happened**, e.g. "someone from the IRS called and said my Social Security number was linked to a crime."

Scam Check:

1. **Reads the item** on camera (who it claims to be from, what it asks for, red flags like urgency or gift cards)
2. **Checks the live web** for recent reports and official warnings about that exact scam (FTC, IRS, AARP, news)
3. **Explains in plain, calm words** whether it's likely a scam, and **what to do now**: don't pay, don't call the
   number on the message, call your bank, or the National Elder Fraud Hotline **1-833-372-8311**, and report at
   ReportFraud.ftc.gov

It never asks for passwords, PINs, Social Security or card numbers.

## How it works

```
 Senior's iPhone ── FaceTime Video ──► Chert (FaceTime line)
                                          │ caller audio + camera
                                          ▼
                                     LiveKit room
                                          │
                                          ▼
                                 Scam Check agent (Node.js)
             ┌────────────────────────────┼─────────────────────────────┐
     OpenAI Realtime voice         look_at_camera tool           search_scam_reports tool
   (listens, talks, decides)   camera frame → OpenAI vision     Keenable live web search
             └──────────────► animated friendly face sent back to the caller
```

| File | Purpose |
|---|---|
| `agent.mjs` | The agent: personality and instructions, OpenAI Realtime voice session, the two tools |
| `camera.mjs` | Subscribes to the caller's FaceTime camera and turns the latest frame into a PNG |
| `scamtools.mjs` | Reads the photo with a vision model; searches Keenable for scam reports |
| `face.mjs` | Draws the animated, friendly face the caller sees |
| `greet.mjs` | Greets the caller once FaceTime is ready |
| `diag.mjs` | Call diagnostics (caller audio level, track events) |
| `test.mjs` | Test the read-and-search pipeline on a photo, without a call |

**Tech:** [Chert](https://www.trychert.com/) FaceTime API · [LiveKit Agents](https://docs.livekit.io/agents/) ·
OpenAI Realtime (`gpt-realtime`) + vision (`gpt-4.1-mini`) · [Keenable](https://keenable.ai) web search

## Run it

Requires macOS or Linux, Node 22.23+/24/26, a [Chert](https://app.trychert.com) project with a FaceTime line,
a [LiveKit Cloud](https://cloud.livekit.io) project, an OpenAI API key and a Keenable API key.

```sh
npm install -g @trychert/facetime@0.1.0-beta.19
npm install
cp .env.example .env.local && chmod 600 .env.local   # fill in your keys
chert login

npm start                           # terminal 1: the agent
chert dev --agent "$AGENT_NAME"     # terminal 2: connect it to your FaceTime line
```

Then FaceTime Video your Chert line. To test the reading and search without a call:

```sh
npm test -- path/to/scam-photo.jpg
```

## What we tested

- Live FaceTime calls: two-way audio, the agent reading real-looking fake IRS emails from the camera
  ("Associate Chief Counsel" SSN request, "Intent to seize your assets" demand), and live web search results
- Describing a scam phone call out loud ("SSN linked to a crime") → web search → clear verdict

## What's next

- Text a photo by iMessage when a video call isn't possible
- Optional alert to a trusted family member after a likely scam
- Help filling in the FTC report
- Pilot with SASCC's older-adult programs and West Valley College's Senior Guided Pathways
