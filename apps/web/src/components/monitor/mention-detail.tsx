import Link from "next/link";
import { LogoutForm } from "@/components/logout-form";
import { projectHref } from "@/monitor/links";
import type { Workspace } from "@/monitor/load";
import type { PresentedMention } from "@/monitor/present";
import { EmptyState, PageHeader, SourceMark } from "./bits";
import { ReviewForm } from "./review-form";
import { Frame } from "./shell";

export function MentionDetail(props: { workspace: Workspace; mention: PresentedMention | null }) {
  const projectId = props.workspace.project?.id ?? null;
  const mention = props.mention;
  return (
    <Frame active="/sebutan" workspace={props.workspace} logout={<LogoutForm />}>
      <Link href={projectHref("/sebutan", projectId)} className="text-sm font-medium text-primary">
        Kembali ke Sebutan
      </Link>
      {props.workspace.projectMissing ? (
        <div className="mt-5">
          <EmptyState
            title="Halaman tidak ditemukan atau Anda tidak memiliki akses."
            body="Kembali ke dasbor untuk membuka proyek Anda."
            action={<Link href="/dasbor" className="text-sm font-medium text-primary">Kembali ke dasbor</Link>}
          />
        </div>
      ) : !mention ? (
        <div className="mt-5">
          <EmptyState title="Sebutan tidak ditemukan." body="Tautan ini tidak cocok dengan sebutan pada proyek ini." />
        </div>
      ) : (
        <div className="mt-4 max-w-xl">
          <PageHeader title="Tinjau penilaian" subtitle={mention.excerpt} />
          <p className="mt-3 text-sm text-muted-foreground">
            <SourceMark source={mention.source} /> {mention.authorLabel}
          </p>
          <div className="mt-5 rounded-[14px] border border-border bg-surface p-4 shadow-card lg:p-5">
            <ReviewForm mention={mention} topics={props.workspace.topicLabels} />
          </div>
        </div>
      )}
    </Frame>
  );
}
