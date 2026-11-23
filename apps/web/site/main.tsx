import { createRoot } from "react-dom/client";
import VoxelBench from "../app/VoxelBench";
import "../app/globals.css";
import "../../../ui/editor-shell.css";
import "../../../ui/editor-controls.css";
import "../app/lab-editor.css";

createRoot(document.getElementById("root")!).render(<VoxelBench />);
