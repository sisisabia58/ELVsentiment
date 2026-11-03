import { AuthScreen } from "@/components/monitor/auth-screen";
import { signUpAction } from "./actions";

export default function SignUpPage() {
  return (
    <AuthScreen
      title="Buat akun"
      lede="Mulai memantau merek Anda dari satu dasbor."
      action={signUpAction}
      submitLabel="Buat akun"
      alternateHref="/masuk"
      alternatePrompt="Sudah punya akun?"
      alternateLabel="Masuk"
      mode="sign-up"
    />
  );
}
