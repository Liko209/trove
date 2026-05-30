// Zero-shot 语义分类：用 bge-m3 算文件 ↔ 类别 prompt 的 cosine similarity
// bge-m3 输出已 L2-normalized，所以 dot product 就是 cosine similarity。
//
// 每个文件用 (filename + 首 chunk 文本前 1500 字符) embed 一次，
// 与预先 embed 的 N 个类别 prompts 算分，取 top-1。

import { basename } from "node:path";
import { embed, embedOne } from "./embed.ts";

export const CATEGORIES = [
  { id: "resume", label: "简历", prompt: "个人简历 工作履历表 个人 CV" },
  { id: "id_proof", label: "身份证明", prompt: "身份证 护照 签证 在职证明 收入证明 学历证明 证件文件" },
  { id: "financial", label: "票据财务", prompt: "发票 收据 银行流水 资产证明 工资单 财务凭证" },
  { id: "contract", label: "Offer 合同", prompt: "录用通知 雇佣合同 工作 offer letter 法律协议 employment agreement" },
  { id: "application", label: "申请文书", prompt: "留学申请 个人陈述 statement of purpose 推荐信 文书写作素材" },
  { id: "insurance", label: "保险方案", prompt: "保单 保险方案 重大疾病保险产品 寿险" },
  { id: "paper", label: "学术论文", prompt: "学术论文 学术研究报告 论文综述 学术文献" },
  { id: "homework", label: "课堂作业", prompt: "课堂作业 习题答案 课程练习题 homework" },
  { id: "slides", label: "课件演示", prompt: "教学课件 上课 PPT 演讲幻灯片 讲义" },
  { id: "tech_doc", label: "技术文档", prompt: "软件技术文档 API 参考 编程教程 工程说明书" },
  { id: "screenshot", label: "截图", prompt: "屏幕截图 screenshot 临时记录" },
  { id: "book", label: "书籍", prompt: "电子书 长篇小说 长篇读物" },
  { id: "meeting", label: "会议邮件", prompt: "会议纪要 工作邮件 沟通记录 备忘录" },
  { id: "form_data", label: "表格数据", prompt: "数据表 统计表 调查问卷 表单" },
  { id: "policy_news", label: "政策新闻", prompt: "政府公文 政策文件 新闻报道 时事文章" },
  { id: "other", label: "其他", prompt: "无法明确分类的杂项文档" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

function cosine(a: number[], b: number[]): number {
  // bge-m3 输出已 normalized → dot = cosine
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export async function precomputePromptVecs(): Promise<number[][]> {
  return embed(CATEGORIES.map((c) => c.prompt));
}

export type Alternative = { id: CategoryId; label: string; score: number };

export type ClassifyResult = {
  category_id: CategoryId;
  category_label: string;
  score: number;
  alternatives: Alternative[];
};

export async function classifyOne(args: {
  source_path: string;
  firstChunkText: string;
  promptVecs: number[][];
}): Promise<ClassifyResult> {
  const head = (args.firstChunkText ?? "").slice(0, 1500);
  const text = `${basename(args.source_path)}\n\n${head}`;
  const vec = await embedOne(text);
  const scored = CATEGORIES.map((c, i) => ({
    id: c.id,
    label: c.label,
    score: cosine(vec, args.promptVecs[i]),
  }));
  scored.sort((a, b) => b.score - a.score);
  const [winner, ...rest] = scored;
  return {
    category_id: winner.id,
    category_label: winner.label,
    score: winner.score,
    alternatives: rest.slice(0, 4),
  };
}
