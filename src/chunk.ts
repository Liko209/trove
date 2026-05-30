// 极简 chunker：按段落组合到约 target 字符，超长段落硬切。
// 留有重叠以保留上下文。
//
// 对真实产品，应当按 source 类型差异化（邮件、消息、笔记、文件），
// 这里只是 spike 用的最小实现。

export function chunkText(text: string, target = 600, overlap = 100): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = overlap > 0 && t.length > overlap ? t.slice(-overlap) + " " : "";
  };

  for (const p of paragraphs) {
    if (p.length > target * 2) {
      // 长段落硬切
      if (buf.trim()) flush();
      for (let i = 0; i < p.length; i += target - overlap) {
        chunks.push(p.slice(i, i + target));
      }
      buf = "";
      continue;
    }
    if (buf.length + p.length + 2 > target) {
      flush();
    }
    buf += (buf ? "\n\n" : "") + p;
  }
  if (buf.trim()) flush();
  return chunks;
}
