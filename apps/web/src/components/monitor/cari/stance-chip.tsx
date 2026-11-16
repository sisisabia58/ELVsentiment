import { cn } from "cn";

const STANCE_STYLE: Record<string, string> = {
  positif: "bg-positif-bg text-positif",
  campuran: "bg-warning-bg text-warning",
  negatif: "bg-negatif-bg text-negatif",
  netral: "bg-netral-bg text-netral",
  faktual: "bg-info-bg text-info",
};

export function StanceChip(props: { stance: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize",
        STANCE_STYLE[props.stance] ?? STANCE_STYLE.netral,
      )}
    >
      {props.stance}
    </span>
  );
}
