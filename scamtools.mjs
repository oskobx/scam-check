// The two "brains" behind the voice: read the item on camera, and check the live web for matching scam reports.

// gpt-4.1-mini reads text from photos in ~1 s (gpt-5-mini with default reasoning took ~7.6 s).
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4.1-mini';

/** Ask a vision model to read what the caller is holding up and flag scam signs. */
export async function readItem(png, callerQuestion = '', mime = 'image/png') {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'system',
          content: `You help an older adult check whether something is a scam. You see one photo from their phone camera.
Reply in plain text with these lines:
WHAT IT IS: (letter, text message, email, gift card, caller ID screen, invoice, website, etc.)
WHO IT CLAIMS TO BE FROM:
WHAT IT ASKS FOR: (money, gift cards, crypto, wire, personal info, click a link, call a number...)
KEY TEXT: (short quotes of the most important words, phone numbers, links, amounts, deadlines)
RED FLAGS: (urgency, threats, unusual payment method, mismatched sender, spelling errors, too good to be true...)
SEARCH QUERY: (a short web search to find reports of this exact scam, e.g. "USPS redelivery fee text scam")
If the image is blurry, too dark, or you can't read it, say UNREADABLE and what to fix (closer, more light, hold still).`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: callerQuestion ? `The caller says: ${callerQuestion}` : 'What is this?' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${png.toString('base64')}`, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`vision ${res.status}: ${json?.error?.message || 'error'}`);
  return json.choices[0].message.content;
}

/** Search the live web (Keenable) for recent reports of a scam. */
export async function searchScamReports(query) {
  const res = await fetch('https://api.keenable.ai/v1/search', {
    method: 'POST',
    headers: { 'X-API-Key': process.env.KEENABLE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: 5, snippet_max_length: 400, published_after: '1y' }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`keenable ${res.status}: ${json?.message || 'error'}`);
  return (json.results || []).map(r => ({
    title: r.title,
    site: safeHost(r.url),
    url: r.url,
    date: r.published_at?.slice(0, 10),
    snippet: r.snippet,
  }));
}

function safeHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
