import { redirect } from "next/navigation";

// Rivals now live with the other matches in "Análisis con video".
export default function Page() {
  redirect("/partidos");
}
