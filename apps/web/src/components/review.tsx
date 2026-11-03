"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AttentionRow = {
  id: string;
  mentionId: string;
  reason: "negative";
  unread: boolean;
  confidence: number;
  url: string;
  excerpt: string;
};

export function AttentionList(props: { items: AttentionRow[]; markError: boolean }) {
  const seen = new Set<string>();
  const items = props.items.filter((item) => {
    if (seen.has(item.mentionId)) return false;
    seen.add(item.mentionId);
    return true;
  });
  const unread = items.filter((item) => item.unread).length;
  return (
    <section>
      <h1>Perlu perhatian</h1>
      <span aria-label={`${unread} baru`}>{unread}</span>
      <p>Label dampak tinggi tidak ditampilkan sampai aturan dan metadata sumber disetujui.</p>
      {props.markError ? <p role="alert">Status perhatian gagal diperbarui.</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <p>{item.excerpt}</p>
            <Badge>Negatif</Badge>
            <p>{item.confidence}</p>
            <a href={item.url}>Buka sumber</a>
            <p>{item.unread ? "Baru" : "Sudah dilihat"}</p>
            <Button type="button">Tandai sudah dilihat</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NotSureList(props: {
  item: {
    uncertain: string;
    originalLabel: string;
    confidence: number;
    url: string;
    sentimentSuggested: "positive" | "neutral" | "negative" | null;
  };
}) {
  return (
    <section>
      <h1>Belum yakin</h1>
      <p>{props.item.uncertain}</p>
      <p>{props.item.originalLabel}</p>
      <p>{props.item.confidence}</p>
      <a href={props.item.url}>Buka sumber</a>
      <Button type="button">Relevan</Button>
      <Button type="button">Tidak relevan</Button>
      <Button type="button">Positif</Button>
      <Button type="button">Netral</Button>
      <Button type="button">Negatif</Button>
      {props.item.sentimentSuggested ? <Button type="button">Setujui label ini</Button> : null}
    </section>
  );
}
