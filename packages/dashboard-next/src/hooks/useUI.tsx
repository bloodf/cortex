import { useContext } from "react";
import { UIContext } from "./ui-context";

export function useUI() {
  const v = useContext(UIContext);
  if (!v) throw new Error("useUI must be used within UIProvider");
  return v;
}
