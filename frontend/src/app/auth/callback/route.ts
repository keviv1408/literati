import { getSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  let signedIn = false;
  if (code && !url.searchParams.has('error')) {
    try {
      const supabase = await getSupabaseServerClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      signedIn = !error;
    } catch {
      signedIn = false;
    }
  }

  return new Response(null, {
    status: 303,
    headers: { Location: signedIn ? '/' : '/?signin=failed', 'Cache-Control': 'private, no-store' },
  });
}
