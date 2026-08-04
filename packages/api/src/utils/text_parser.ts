export function extractJson(text: string): string {
  // 1. Try to find markdown blocks
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```([\s\S]*?)```/);
  if (jsonMatch && jsonMatch[1]) return jsonMatch[1].trim();

  // 2. Fallback: Find the first { and the last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1).trim();
  }

  return text.trim();
}
