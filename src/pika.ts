// Pika Micropub API: https://pika.page/manual/micropub

const MICROPUB = 'https://pika.page/micropub';
const MEDIA = 'https://pika.page/micropub/media';

// Pika asked us to slow down. The run stops and tries again on the next schedule.
export class RateLimited extends Error {
  constructor() {
    super('Pika rate limit reached');
    this.name = 'RateLimited';
  }
}

async function detail(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string };
    return body.error_description || body.error || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || response.statusText;
  }
}

export async function uploadImage(token: string, blob: Blob, index: number): Promise<string> {
  const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type === 'image/gif' ? 'gif' : 'jpg';
  const form = new FormData();
  form.set('file', blob, `bluesky-${index + 1}.${extension}`);
  const response = await fetch(MEDIA, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (response.status === 429) throw new RateLimited();
  const location = response.headers.get('location');
  if (response.status !== 201 || !location) throw new Error(`Pika image upload failed: HTTP ${response.status} ${await detail(response)}`);
  return location;
}

export interface NewPost {
  content: string;
  tags: string[];
  published: string;
}

// Creates a published post and returns its URL.
export async function publishPost(token: string, post: NewPost): Promise<string> {
  const response = await fetch(MICROPUB, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: ['h-entry'],
      properties: {
        content: [post.content],
        category: post.tags,
        published: [post.published],
        'post-status': ['published']
      }
    })
  });
  if (response.status === 429) throw new RateLimited();
  const location = response.headers.get('location');
  if (response.status !== 201 || !location) throw new Error(`Pika post failed: HTTP ${response.status} ${await detail(response)}`);
  return location;
}

// Confirms the token works. Pika answers with its media endpoint.
export async function checkToken(token: string): Promise<boolean> {
  const response = await fetch(`${MICROPUB}?q=config`, { headers: { Authorization: `Bearer ${token}` } });
  return response.ok;
}
