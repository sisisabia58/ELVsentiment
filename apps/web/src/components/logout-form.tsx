import { cn } from "cn";
import { signOutAction } from "@/app/masuk/actions";
import { Button } from "@/components/ui/button";

export function LogoutForm(props: { buttonClassName?: string }) {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" className={cn("h-11 min-h-11 px-2", props.buttonClassName)}>
        Keluar
      </Button>
    </form>
  );
}
