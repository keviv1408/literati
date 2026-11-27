interface DeclarationTurnPassPromptProps {
  isMyTurn: boolean;
  chooserName: string | null;
  pending: boolean;
}

export default function DeclarationTurnPassPrompt({
  isMyTurn,
  chooserName,
  pending,
}: DeclarationTurnPassPromptProps) {
  let message = `${chooserName ?? 'Someone'} is choosing who plays next.`;
  if (isMyTurn) {
    message = pending ? 'Passing the turn…' : 'Tap a highlighted teammate to play next.';
  }
  return (
    <span
      role="status"
      className={`text-sm font-medium ${isMyTurn ? 'text-cyan-100' : 'text-slate-200'}`}
      data-testid={isMyTurn ? 'turn-pass-action-prompt' : 'waiting-prompt'}
    >
      {message}
    </span>
  );
}
