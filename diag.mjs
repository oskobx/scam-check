// Audio diagnostics: is the caller's microphone reaching us, and is the Chert Mac taking our voice?
import { AudioStream, RoomEvent, TrackKind } from '@livekit/rtc-node';

export function audioDiagnostics(room, session, voice, log) {
  const kind = k => (k === TrackKind.KIND_AUDIO ? 'audio' : k === TrackKind.KIND_VIDEO ? 'video' : 'other');

  room.on(RoomEvent.LocalTrackSubscribed, track => log(`Mac subscribed to our ${kind(track.kind)} track "${track.name}"`));
  room.on(RoomEvent.TrackPublished, (pub, p) => log(`${p.identity} published ${kind(pub.kind)} "${pub.name}"`));
  room.on(RoomEvent.TrackMuted, (pub, p) => log(`${p.identity} MUTED ${kind(pub.kind)} "${pub.name}"`));
  room.on(RoomEvent.TrackUnmuted, (pub, p) => log(`${p.identity} unmuted ${kind(pub.kind)} "${pub.name}"`));

  const meter = track => {
    log(`metering caller audio "${track.name}"`);
    const reader = new AudioStream(track).getReader();
    let frames = 0, peak = 0, sumSq = 0, samples = 0;
    const timer = setInterval(() => {
      const rms = samples ? Math.sqrt(sumSq / samples) : 0;
      log(`caller mic: ${frames} frames, level ${rms.toFixed(0)} rms / ${peak} peak ${rms < 30 ? '(SILENT)' : '(sound)'}`);
      frames = 0; peak = 0; sumSq = 0; samples = 0;
    }, 3000);
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          frames++;
          for (const s of value.data) { const a = Math.abs(s); if (a > peak) peak = a; sumSq += s * s; samples++; }
        }
      } catch { /* ended */ }
      clearInterval(timer);
    })();
  };

  const onSub = (track, _pub, p) => {
    log(`subscribed to ${p.identity} ${kind(track.kind)} "${track.name}"`);
    if (track.kind === TrackKind.KIND_AUDIO) meter(track);
  };
  room.on(RoomEvent.TrackSubscribed, onSub);
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      log(`${p.identity} already has ${kind(pub.kind)} "${pub.name}" subscribed=${!!pub.track}`);
      if (pub.track) onSub(pub.track, pub, p);
    }
  }

  session.on(voice.AgentSessionEventTypes.UserStateChanged, e => log(`user is ${e.newState}`));
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, e => log(`agent is ${e.newState}`));
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, e => { if (e.isFinal) log(`heard caller: "${e.transcript}"`); });
}
