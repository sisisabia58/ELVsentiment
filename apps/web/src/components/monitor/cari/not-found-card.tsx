import Link from "next/link";
import { EmptyState } from "@/components/monitor/bits";

export function CariNotFoundCard() {
  return (
    <EmptyState
      title="Pencarian tidak ditemukan."
      body="Pencarian ini tidak ada atau bukan milik akun Anda. Coba cari lagi dari halaman Cari sekarang."
      action={
        <Link href="/cari" className="text-sm font-medium text-primary">
          Kembali ke Cari sekarang
        </Link>
      }
    />
  );
}
