import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, llm, ServerOptions, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import { LocalVideoTrack, TrackSource, VideoBufferType, VideoFrame, VideoSource } from '@livekit/rtc-node';
import { z } from 'zod';
import { watchCallerCamera } from './camera.mjs';
import { audioDiagnostics } from './diag.mjs';
import { drawFace, FPS, HEIGHT, WIDTH } from './face.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { readItem, searchScamReports } from './scamtools.mjs';

const instructions = `You are "Scam Check", a calm, kind AI helper on a FaceTime video call with an older adult.
People call you when they get something suspicious: a letter, a text or email on their phone, a bill, a gift card request,
a caller ID screen, or a strange phone call they just had.

How you talk:
- Speak slowly and simply. One or two short sentences at a time. No jargon. Never rush or scold.
- Be clear you are an AI helper, not the police, bank, or government.
- Always speak English. The caller may be in a noisy room: ignore background chatter, short noises, and stray words or
  fragments in other languages. If you didn't clearly catch what they said, kindly ask them to repeat it.

Privacy (very important):
- Never ask for passwords, PINs, verification codes, Social Security numbers, bank or card numbers, or date of birth.
  If they start to read one out, gently stop them: "You don't need to tell me that. Please keep it private."
- Never repeat back any personal detail you see or hear (their name, address, account or ID numbers).
  Talk about the scam, not about them. The tools already hide personal details; keep it that way.
- If they ask, explain simply: you don't record calls, you don't save pictures, and you only look when they ask you to.

How you help:
1. Ask them to hold the item up to the camera, close and steady, with good light.
2. Say "Let me take a look" and call look_at_camera. If it's unreadable, tell them exactly what to fix and try again.
3. Then say "Let me check if others have reported this" and call search_scam_reports with the suggested search query.
4. Give a clear verdict: "This looks like a scam", "This looks safe, but let's double-check", or "I'm not sure".
   Explain the one or two biggest warning signs in plain words, and mention what you found online, e.g. "the FTC warned about this exact text".
5. Tell them what to do now: don't click, don't call the number on the message, don't pay, especially not with gift cards, wire, or crypto.
   If it claims to be from a real company or agency, call the number on their card or official website instead.
   If it's a family emergency call, hang up and call that family member directly, or use a family code word.
6. If they already paid or shared information: stay calm, tell them to call their bank right away,
   then the National Elder Fraud Hotline at 1-833-372-8311, and report at ReportFraud.ftc.gov.
If they describe a phone call instead of showing something, you can still use search_scam_reports based on what they tell you.`;

const greeting = 'Greet the caller warmly in two short sentences: you are Scam Check, an AI helper, and they can hold up anything suspicious or tell you what happened. Then say this call is not recorded, and they should never share passwords or ID numbers with anyone, including you.';

// Privacy: by default nothing the caller says or shows is written to the logs. Set SCAMCHECK_DEBUG=1 to troubleshoot.
const DEBUG = process.env.SCAMCHECK_DEBUG === '1';

export default defineAgent({
  entry: async ctx => {
    const log = (...a) => console.log(`[scam-check ${new Date().toISOString().slice(11, 19)}]`, ...a);
    // Join exactly like Chert's starter (audio-only); we opt in to the caller's camera track later.
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    log('joined room', ctx.room.name, '- waiting for caller');
    const caller = await ctx.waitForParticipant();
    log('caller is', caller.identity);
    ctx.room.on('roomMetadataChanged', () => log('room metadata:', ctx.room.metadata));
    const camera = watchCallerCamera(ctx.room, p => p.identity.startsWith('chert-bridge'));

    // Our own animated face, published from the same participant that speaks.
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let tick = 0, speaking = false;
    const frame = () => source.captureFrame(new VideoFrame(drawFace(tick++, speaking), WIDTH, HEIGHT, VideoBufferType.RGBA));
    frame();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(frame, 1000 / FPS);
    log('published face video');

    const tools = {
      look_at_camera: llm.tool({
        description: "Look at what the caller is holding up to their camera right now and read it. Returns what it is, key text, and red flags.",
        parameters: z.object({ question: z.string().describe("What the caller said about the item, or '' if nothing") }),
        execute: async ({ question }) => {
          const png = camera.snapshotPng();
          console.log(`[look_at_camera] called (${png ? 'have a camera frame' : 'NO camera frame'})${DEBUG ? ` question="${question}"` : ''}`);
          if (!png) return 'No camera picture right now. Ask the caller to switch to FaceTime Video, turn their camera on, and hold the item up.';
          try {
            const result = await readItem(png, question); // image is sent once, never saved; personal details redacted
            if (DEBUG) console.log('[look_at_camera]\n' + result);
            return result;
          } catch (e) {
            console.error('[look_at_camera] failed:', e?.message);
            return "Couldn't read the picture due to a technical problem. Ask them to describe it or read the sender and what it asks for.";
          }
        },
      }),
      search_scam_reports: llm.tool({
        description: 'Search the live web for recent reports and official warnings (FTC, FBI, AARP, news) about a possible scam.',
        parameters: z.object({ query: z.string().describe('Short search, e.g. "Amazon account suspended text scam"') }),
        execute: async ({ query }) => {
          try {
            const results = await searchScamReports(query);
            console.log(`[search_scam_reports] ${results.length} results${DEBUG ? ` for "${query}"` : ''}`);
            if (!results.length) return 'No reports found online. That does not mean it is safe.';
            return JSON.stringify(results);
          } catch (e) {
            console.error('[search_scam_reports] failed:', e?.message);
            return 'The web search is unavailable right now. Judge from the warning signs alone.';
          }
        },
      }),
    };

    const session = new voice.AgentSession({
      llm: new realtime.RealtimeModel({
        model: process.env.REALTIME_MODEL || 'gpt-realtime',
        voice: 'marin',
        // Noisy rooms: suppress far-away sound, and need clearer speech before taking a turn.
        inputAudioNoiseReduction: { type: 'near_field' },
        turnDetection: { type: 'server_vad', threshold: 0.8, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true },
        inputAudioTranscription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
      }),
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, event => { speaking = event.newState === 'speaking'; });
    audioDiagnostics(ctx.room, session, voice, log, DEBUG);
    ctx.addShutdownCallback(async () => {
      clearInterval(timer);
      camera.close();
      await session.close();
      await track.close();
      await source.close();
    });
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions, tools }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false, // we read the camera ourselves via look_at_camera
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });
    log('voice session started (audio track published)');
    session.on(voice.AgentSessionEventTypes.Error, e => log('SESSION ERROR', e?.error?.message || e));
    const stopGreeting = greetOnBridgeReady(ctx.room, () => { log('bridge ready -> greeting'); return session.generateReply({ instructions: greeting }); });
    ctx.addShutdownCallback(async () => stopGreeting());
  },
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: process.env.AGENT_NAME || 'scam-check',
}));
