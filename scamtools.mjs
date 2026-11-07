// The two "brains" behind the voice: read the item on camera, and check the live web for matching scam reports.
//
// Privacy: the caller's own personal details (name, address, account / Social Security / card numbers, email)
// are redacted twice: by instruction to the vision model, and again in code (scrubPersonal) as a safety net.
// The web search never contains personal details or any numbers, only a plain description of the scam type.

// gpt-4.1-mini reads text from photos in ~1 s (gpt-5-mini with default reasoning took ~7.6 s).
const VISION_MODEL = process.env.VISION_MODEL || 'gpt-4.1-mini';

/** Remove numbers that identify a person: SSNs, card and account numbers. Keeps short numbers like amounts. */
export function scrubPersonal(text) {
  return String(text)
    .replace(/\b(?:account|acct|member|policy|case)\s*(?:no\.?|number|#)\s*:?\s*[A-Z0-9-]*\d[A-Z0-9-]{3,}/gi, '[redacted]') // labelled numbers
    .replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, '[redacted]')                                  // SSN-like
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[redacted]');                                        // card-like
}

/** A search query that can't leak personal data: no digits, no emails, no URLs, short. */
export function safeSearchQuery(query) {
  return String(query)
    .replace(/\S+@\S+/g, ' ')            // emails
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ') // links
    .replace(/[+()\d][\d\s().+-]{5,}\d/g, ' ') // phone / account / long numbers
    .replace(/\d/g, ' ')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Ask a vision model to read what the caller is holding up and flag scam signs. */
export async function readItem(png, callerQuestion = '', mime = 'image/png') {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      store: false, // don't keep this request in OpenAI's stored completions
      messages: [
        {
          role: 'system',
          content: `You help an older adult check whether something is a scam. You see one photo from their phone camera.

PRIVACY RULES (always):
- Never write out the recipient's personal details: their name, home address, email, phone number, date of birth,
  Social Security number, or any account, card, policy, case or member number. Write [redacted] instead.
- You MAY quote the sender's claimed identity and the scammer's contact details (the phone number or link they want
  the person to use), because the caller needs to know not to use them.

Reply in plain text with these lines:
WHAT IT IS: (letter, text message, email, gift card, caller ID screen, invoice, website, etc.)
WHO IT CLAIMS TO BE FROM:
WHAT IT ASKS FOR: (money, gift cards, crypto, wire, personal info, click a link, call a number...)
KEY TEXT: (short quotes of the most important words, the scammer's phone numbers/links, amounts, deadlines; personal details redacted)
RED FLAGS: (urgency, threats, unusual payment method, mismatched sender, spelling errors, too good to be true...)
SEARCH QUERY: (a short plain-language description of the scam type, with NO names, numbers, links or personal details,
e.g. "USPS redelivery fee text scam" or "IRS email threatening asset seizure scam")
If the image is blurry, too dark, or you can't read it, say UNREADABLE and what to fix (closer, more light, hold still).`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: callerQuestion ? `The caller says: ${scrubPersonal(callerQuestion)}` : 'What is this?' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${png.toString('base64')}`, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`vision ${res.status}: ${json?.error?.message || 'error'}`);
  return scrubPersonal(json.choices[0].message.content);
}

/** Search the live web (Keenable) for recent reports of a scam. The query is sanitized first. */
export async function searchScamReports(query) {
  const q = safeSearchQuery(query);
  if (!q) return [];
  const res = await fetch('https://api.keenable.ai/v1/search', {
    method: 'POST',
    headers: { 'X-API-Key': process.env.KEENABLE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, max_results: 5, snippet_max_length: 400, published_after: '1y' }),
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
