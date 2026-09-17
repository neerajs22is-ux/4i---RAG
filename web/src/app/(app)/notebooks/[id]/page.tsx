import { NotebookWorkspace } from "@/components/notebooks/notebook-workspace";

export const metadata = { title: "Space · RAG-4i" };

export default async function NotebookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <NotebookWorkspace key={id} notebookId={id} />;
}
