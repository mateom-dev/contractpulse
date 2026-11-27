-- CreateTable
CREATE TABLE "dependencies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "consumer_service_id" UUID NOT NULL,
    "provider_service_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "version_sequence" INTEGER NOT NULL,
    "uses" TEXT[],
    "note" TEXT,
    "recorded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dependencies_workspace_id_contract_id_idx" ON "dependencies"("workspace_id", "contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "dependencies_consumer_service_id_contract_id_key" ON "dependencies"("consumer_service_id", "contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_workspace_id_service_id_id_key" ON "contracts"("workspace_id", "service_id", "id");

-- AddForeignKey
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_workspace_id_consumer_service_id_fkey" FOREIGN KEY ("workspace_id", "consumer_service_id") REFERENCES "services"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_workspace_id_provider_service_id_contract_id_fkey" FOREIGN KEY ("workspace_id", "provider_service_id", "contract_id") REFERENCES "contracts"("workspace_id", "service_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_contract_id_version_sequence_fkey" FOREIGN KEY ("contract_id", "version_sequence") REFERENCES "contract_versions"("contract_id", "sequence") ON DELETE CASCADE ON UPDATE CASCADE;


-- A service never consumes its own contract; versions are numbered from 1.
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_not_self_check" CHECK ("consumer_service_id" <> "provider_service_id");
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_version_sequence_check" CHECK ("version_sequence" >= 1);
-- `uses` lists JSON Pointers into the pinned version; empty means the whole contract.
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_uses_check" CHECK (
  "uses" IS NOT NULL
  AND cardinality("uses") <= 200
  AND array_position("uses", NULL) IS NULL
);
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_recorded_by_check" CHECK (length("recorded_by") > 0);
