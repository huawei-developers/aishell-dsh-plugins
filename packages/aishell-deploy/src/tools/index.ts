import type { ToolRegistrar } from "../types.js";
import { z } from "zod";

import { registerDeploymentTools } from "./deployment.js";
import { registerPricingTool } from "./pricing.js";
import { registerSpecsTool } from "./specs.js";
import { registerDesignTool } from "./design.js";
import { registerOpenApiTools } from "./openapi.js";
import { registerExamplesTool } from "./examples.js";
import { registerExistingResourcesTool } from "./existing_resources.js";
import { registerProviderSchemaTool } from "./provider_schema.js";
import { registerTerraformTools } from "./terraform.js";

/**
 * Register this plugin's tools on the DSH tool registry.
 *
 * Tool count: 18.
 *
 *   部署目录 2 + 设计校验 1 + 规格 1 + 报价 1 + 华为云能力 4 + terraform 9 = 18
 *
 * ## No tool accepts a price
 *
 * `price_resources` writes `cost.json` from the rating API, and every figure in
 * it came from an inquiry. The gate that protects an apply compares that record
 * against the configuration, so its value rests on the numbers being quoted
 * rather than supplied — a tool taking a hand-typed amount would be the one path
 * by which a fabricated figure reached the record.
 *
 * ## No tool answers "am I authenticated"
 *
 * That lives in `aishell-credentials`, which owns the credential lifecycle and
 * the form that collects AK/SK. A verify tool here would mean two tools
 * answering the same question, one of them depending on a store it does not own.
 *
 * ## Long-running tools run synchronously
 *
 * install/init/plan/apply/destroy/refresh each run to completion within the
 * call. The per-call budget is what bounds them; there is no progress channel
 * to poll and no background handle to lose track of.
 */
export function registerAllTools(registrar: ToolRegistrar): void {
  // 部署目录管理 (2)
  registerDeploymentTools(registrar);

  // 网络设计：校验 + 出图。不需要凭据，也不创建任何资源。
  registerDesignTool(registrar);

  // 规格与成本 — flavours and images are values only the region knows;
  // the price is whatever the account is actually charged.
  registerSpecsTool(registrar);
  registerPricingTool(registrar);

  // 华为云能力 (4) — `auth` lives in aishell-credentials
  registerOpenApiTools(registrar);
  registerExamplesTool(registrar);
  registerExistingResourcesTool(registrar);
  // provider_schema reads what terraform installed locally, so it registers with
  // the terraform tools rather than the cloud-capability ones above.

  // Terraform execution (9): the eight in `registerTerraformTools` plus
  // `provider_schema`, which reads what terraform installed locally.
  registerProviderSchemaTool(registrar);
  registerTerraformTools(registrar);
}

/**
 * Shared zod string schema for the `deployment` parameter — an absolute or
 * relative path to the deployment workspace directory. Used by every tool
 * that operates on a deployment.
 */
export const deploymentParam = z.string().min(1).describe("部署工作区目录路径（绝对或相对）");

/**
 * Shared zod string schema for `dest` — where reference data is extracted.
 *
 * A target of its own, not the deployment workspace: the terraform examples are
 * material to read while writing a configuration, and dropping them into the
 * workspace would put a few hundred `.tf` files where `configurationFiles`
 * reads the deployment's own.
 */
export const destParam = z.string().min(1).describe("导出目标目录路径（参考数据，不是 deployment 工作区）");
