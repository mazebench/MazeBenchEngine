import type { Metadata } from "next";
import VoxelBench from "./VoxelBench";

export const metadata: Metadata = {
  title: "VoxelBench — Visual physics tests",
  description:
    "Build sparse 3D voxel scenes and test every turn of a Sokoban-like physics engine.",
};

export default function Home() {
  return <VoxelBench />;
}
