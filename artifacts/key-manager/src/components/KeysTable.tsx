import { useState } from "react";
import { useListKeys, useUpdateKey, useDeleteKey, getListKeysQueryKey, getGetKeyStatsQueryKey, type ApiKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Copy, Trash2, Edit2, Eye, EyeOff, KeyRound, Zap, CheckCircle2, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EditKeyDialog } from "./EditKeyDialog";
import { Empty } from "@/components/ui/empty";

type ValidateStatus = "valid" | "no_balance" | "invalid" | "unreachable";
type ValidateResult = { status: ValidateStatus; message: string; httpStatus: number };

async function validateKey(id: number, baseUrl: string): Promise<ValidateResult> {
  const resp = await fetch(`${baseUrl}keys/${id}/validate`, { method: "POST" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api/";

function ValidateBadge({ result }: { result: ValidateResult }) {
  if (result.status === "valid") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Valid
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.message}</TooltipContent>
      </Tooltip>
    );
  }
  if (result.status === "no_balance") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-600">
            <AlertCircle className="h-3.5 w-3.5" />
            No Balance
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.message}</TooltipContent>
      </Tooltip>
    );
  }
  if (result.status === "unreachable") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5" />
            Offline
          </span>
        </TooltipTrigger>
        <TooltipContent>{result.message}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
          <XCircle className="h-3.5 w-3.5" />
          Invalid
        </span>
      </TooltipTrigger>
      <TooltipContent>{result.message}</TooltipContent>
    </Tooltip>
  );
}

export function KeysTable() {
  const { data: keys, isLoading } = useListKeys();
  const updateKey = useUpdateKey();
  const deleteKey = useDeleteKey();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [visibleKeys, setVisibleKeys] = useState<Set<number>>(new Set());
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [validating, setValidating] = useState<Set<number>>(new Set());
  const [validateResults, setValidateResults] = useState<Map<number, ValidateResult>>(new Map());

  const toggleVisibility = (id: number) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCopy = async (keyText: string) => {
    await navigator.clipboard.writeText(keyText);
    toast({
      title: "Copied to clipboard",
      description: "The API key has been copied.",
    });
  };

  const handleValidate = async (key: ApiKey) => {
    setValidating((prev) => new Set(prev).add(key.id));
    try {
      const result = await validateKey(key.id, BASE_URL);
      setValidateResults((prev) => new Map(prev).set(key.id, result));
      const statusLabel: Record<ValidateStatus, string> = {
        valid: "Key is valid",
        no_balance: "Key valid but no balance",
        invalid: "Key is invalid",
        unreachable: "API unreachable",
      };
      toast({
        title: statusLabel[result.status],
        description: result.message,
        variant: result.status === "valid" || result.status === "no_balance" ? "default" : "destructive",
      });
    } catch (e) {
      toast({
        title: "Validation failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setValidating((prev) => {
        const next = new Set(prev);
        next.delete(key.id);
        return next;
      });
    }
  };

  const handleToggleActive = (key: ApiKey, isActive: boolean) => {
    updateKey.mutate(
      { id: key.id, data: { isActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetKeyStatsQueryKey() });
          toast({
            title: `Key ${isActive ? 'enabled' : 'disabled'}`,
            description: `The key ${key.name} is now ${isActive ? 'active' : 'inactive'}.`,
          });
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to update key status.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleDelete = () => {
    if (!deleteConfirmId) return;
    deleteKey.mutate(
      { id: deleteConfirmId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetKeyStatsQueryKey() });
          setDeleteConfirmId(null);
          toast({
            title: "Key deleted",
            description: "The API key has been removed.",
          });
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to delete key.",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center space-x-4">
            <Skeleton className="h-12 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!keys?.length) {
    return (
      <Empty
        icon={KeyRound}
        title="No keys found"
        description="Add a new API key or import existing ones to get started."
        className="py-12"
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[200px]">Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="text-right w-[160px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((key) => {
            const isVisible = visibleKeys.has(key.id);
            const maskedKey = key.key.substring(0, 6) + "****************";
            const validateResult = validateResults.get(key.id);
            const isValidating = validating.has(key.id);
            
            return (
              <TableRow key={key.id} className="group">
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span data-testid={`text-key-name-${key.id}`}>{key.name}</span>
                    {key.note && (
                      <span className="text-xs text-muted-foreground truncate max-w-[180px]" title={key.note}>
                        {key.note}
                      </span>
                    )}
                    {validateResult && (
                      <div className="mt-0.5">
                        <ValidateBadge result={validateResult} />
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  <div className="flex items-center gap-2">
                    <span data-testid={`text-key-value-${key.id}`}>
                      {isVisible ? key.key : maskedKey}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => toggleVisibility(key.id)}
                      data-testid={`button-toggle-visibility-${key.id}`}
                    >
                      {isVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleCopy(key.key)}
                      data-testid={`button-copy-key-${key.id}`}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  {key.provider ? (
                    <Badge variant="secondary" className="font-normal" data-testid={`badge-provider-${key.id}`}>
                      {key.provider}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format(new Date(key.createdAt), "MMM d, yyyy")}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={key.isActive}
                    onCheckedChange={(checked) => handleToggleActive(key, checked)}
                    data-testid={`switch-active-${key.id}`}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-yellow-500"
                          onClick={() => handleValidate(key)}
                          disabled={isValidating}
                          data-testid={`button-validate-${key.id}`}
                        >
                          {isValidating
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Zap className="h-4 w-4" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Test key against Sapiom API</TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                      onClick={() => setEditingKey(key)}
                      data-testid={`button-edit-${key.id}`}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setDeleteConfirmId(key.id)}
                      data-testid={`button-delete-${key.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the API key from your manager.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editingKey && (
        <EditKeyDialog
          key={editingKey.id}
          apiKey={editingKey}
          open={!!editingKey}
          onOpenChange={(open) => !open && setEditingKey(null)}
        />
      )}
    </>
  );
}
