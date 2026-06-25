import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "../../components/primitives/Button";
import s from "./compare.module.css";

interface Props {
  label: string;
  side: "a" | "b";
  value: string;
  onPick: (path: string) => void;
}

/** Folder picker via tauri-plugin-dialog. The only place we touch the dialog
 * plugin in this feature; the chosen path is normalized to forward-slash. */
export function FolderPicker({ label, side, value, onPick }: Props) {
  async function pick() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onPick(picked);
  }
  const sideColor = side === "a" ? "--side-a" : "--side-b";
  return (
    <div className={s.folder}>
      <span className={s.folderLabel}>
        <span className={s.sidePill} style={{ background: `var(${sideColor})` }}>
          {side.toUpperCase()}
        </span>
        {label}
      </span>
      <div className={s.folderRow}>
        <input
          className={s.pathInput}
          readOnly
          value={value}
          placeholder="Choose a folder…"
          title={value}
        />
        <Button onClick={pick}>Browse</Button>
      </div>
    </div>
  );
}
