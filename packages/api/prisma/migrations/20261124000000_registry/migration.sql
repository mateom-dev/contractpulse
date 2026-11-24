-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_versions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "declared_version" TEXT,
    "spec_version" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "source_repository" TEXT,
    "source_ref" TEXT,
    "imported_by" TEXT NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_workspace_id_idx" ON "api_tokens"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_workspace_id_slug_key" ON "services"("workspace_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "services_workspace_id_id_key" ON "services"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_service_id_name_key" ON "contracts"("service_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_workspace_id_id_key" ON "contracts"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "contract_versions_workspace_id_hash_idx" ON "contract_versions"("workspace_id", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_contract_id_sequence_key" ON "contract_versions"("contract_id", "sequence");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_workspace_id_service_id_fkey" FOREIGN KEY ("workspace_id", "service_id") REFERENCES "services"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_workspace_id_contract_id_fkey" FOREIGN KEY ("workspace_id", "contract_id") REFERENCES "contracts"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Contract kinds and version numbers
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_kind_check" CHECK ("kind" IN ('openapi', 'json-schema'));
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_kind_check" CHECK ("kind" IN ('openapi', 'json-schema'));
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_sequence_check" CHECK ("sequence" >= 1);
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_hash_check" CHECK ("hash" ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 1048576);

-- Version history is append-only: an imported version is never edited.
CREATE FUNCTION "contract_versions_reject_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract_versions rows are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "contract_versions_immutable"
  BEFORE UPDATE ON "contract_versions"
  FOR EACH ROW EXECUTE FUNCTION "contract_versions_reject_update"();
