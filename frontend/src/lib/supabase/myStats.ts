import { ApiError, type ProfileResponse } from '@/lib/api';
import { getSupabaseBrowserClient } from './client';

export async function getMyStats(userId: string): Promise<ProfileResponse> {
  const client = getSupabaseBrowserClient();
  const [profile, stats] = await Promise.all([
    client.from('user_profiles').select('display_name, avatar_id').eq('id', userId).maybeSingle(),
    client.from('user_stats')
      .select('games_completed, games_played, wins, losses, declarations_attempted, declarations_correct, declarations_incorrect')
      .eq('user_id', userId).maybeSingle(),
  ]);
  if (profile.error || stats.error) throw new Error('Could not load your stats.');
  if (!profile.data) throw new ApiError(404, 'Profile not found');

  const row = stats.data;
  const gamesCompleted = row?.games_completed ?? 0;
  const wins = row?.wins ?? 0;
  const declarationsCorrect = row?.declarations_correct ?? 0;
  const declarationsIncorrect = row?.declarations_incorrect ?? 0;

  return {
    profile: {
      userId,
      displayName: profile.data.display_name,
      avatarId: profile.data.avatar_id,
      gamesCompleted,
      gamesPlayed: row?.games_played ?? 0,
      wins,
      losses: row?.losses ?? 0,
      winRate: gamesCompleted ? Math.round(wins / gamesCompleted * 100) / 100 : 0,
      declarationsCorrect,
      declarationsIncorrect,
      declarationsAttempted: row?.declarations_attempted ?? declarationsCorrect + declarationsIncorrect,
    },
  };
}
