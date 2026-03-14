import express from "express";
import supabase from "../db.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER 1: Update usdrate field on every variant in exportproducts (air + sea)
//           and recalculate exfactoryprice using the new rate
// ─────────────────────────────────────────────────────────────────────────────
const updateVariantUsdRates = async (newUsdRate) => {
  console.log(
    `[Variant USD Update] Updating all variants to rate: ${newUsdRate}`,
  );

  const tables = ["exportproducts", "exportproductsair"];
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const table of tables) {
    try {
      const { data: products, error: fetchError } = await supabase
        .from(table)
        .select("id, variants");

      if (fetchError) {
        console.error(
          `[Variant USD Update] Fetch error from ${table}:`,
          fetchError,
        );
        totalErrors++;
        continue;
      }

      if (!products || products.length === 0) continue;

      for (const product of products) {
        if (
          !product.variants ||
          !Array.isArray(product.variants) ||
          product.variants.length === 0
        )
          continue;

        try {
          const updatedVariants = product.variants.map((variant) => {
            const purchasePrice = parseFloat(variant.purchasing_price) || 0;
            const jcFobUSD = parseFloat(variant.jc_fob) || 0;
            const packingCostUSD = parseFloat(variant.packing_cost) || 0;
            const labourUSD = parseFloat(variant.labour_overhead) || 0;
            const profitUSD = parseFloat(variant.profit) || 0;

            // base: use purchasing_price if > 0, otherwise jc_fob × new rate
            const base =
              purchasePrice > 0 ? purchasePrice : jcFobUSD * newUsdRate;

            const newExFactory = parseFloat(
              (
                base +
                (packingCostUSD + labourUSD + profitUSD) * newUsdRate
              ).toFixed(2),
            );

            return {
              ...variant,
              usdrate: newUsdRate,
              exfactoryprice: newExFactory,
            };
          });

          const { error: updateError } = await supabase
            .from(table)
            .update({ variants: updatedVariants })
            .eq("id", product.id);

          if (updateError) {
            console.error(
              `[Variant USD Update] Error on ${table} product ${product.id}:`,
              updateError,
            );
            totalErrors++;
          } else {
            totalUpdated++;
          }
        } catch (err) {
          console.error(
            `[Variant USD Update] Exception on ${table} product ${product.id}:`,
            err,
          );
          totalErrors++;
        }
      }
    } catch (err) {
      console.error(`[Variant USD Update] Fatal error on table ${table}:`, err);
      totalErrors++;
    }
  }

  console.log(
    `[Variant USD Update] Done — ${totalUpdated} products updated, ${totalErrors} errors`,
  );
  return { totalUpdated, totalErrors };
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER 2: Recalculate FOB + CNF in exportcustomer_product with new USD rate
// ─────────────────────────────────────────────────────────────────────────────
const recalculateCustomerPrices = async (newUsdRate) => {
  console.log(`[Customer Price Recalc] Starting with USD rate: ${newUsdRate}`);

  try {
    const { data: products, error: fetchError } = await supabase
      .from("exportcustomer_product")
      .select("*");

    if (fetchError) throw fetchError;
    if (!products || products.length === 0) {
      console.log("[Customer Price Recalc] No customer products found");
      return { updated: 0, errors: 0 };
    }

    let updated = 0;
    let errors = 0;

    for (const product of products) {
      try {
        const exfactoryprice = parseFloat(product.exfactoryprice) || 0;
        const export_doc = parseFloat(product.export_doc) || 0;
        const transport_cost = parseFloat(product.transport_cost) || 0;
        const loading_cost = parseFloat(product.loading_cost) || 0;
        const airway_cost = parseFloat(product.airway_cost) || 0;
        const forwardHandling_cost =
          parseFloat(product.forwardHandling_cost) || 0;

        // Total handling (USD) → LKR with new rate → add to ex-factory (LKR) = FOB (LKR)
        const totalHandlingUSD =
          export_doc +
          transport_cost +
          loading_cost +
          airway_cost +
          forwardHandling_cost;
        const newFobPrice = parseFloat(
          (exfactoryprice + totalHandlingUSD * newUsdRate).toFixed(2),
        );

        // FOB in USD with new rate
        const fobInUSD = newFobPrice / newUsdRate;

        const updates = { fob_price: newFobPrice };

        if (product.freight_type === "air") {
          updates.cnf_45kg = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_45kg) || 0)).toFixed(
              2,
            ),
          );
          updates.cnf_100kg = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_100kg) || 0)).toFixed(
              2,
            ),
          );
          updates.cnf_300kg = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_300kg) || 0)).toFixed(
              2,
            ),
          );
          updates.cnf_500kg = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_500kg) || 0)).toFixed(
              2,
            ),
          );
        } else if (product.freight_type === "sea") {
          updates.cnf_20ft = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_20ft) || 0)).toFixed(
              2,
            ),
          );
          updates.cnf_40ft = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost_40ft) || 0)).toFixed(
              2,
            ),
          );
        } else {
          // generic cnf fallback
          updates.cnf = parseFloat(
            (fobInUSD + (parseFloat(product.freight_cost) || 0)).toFixed(2),
          );
        }

        const { error: updateError } = await supabase
          .from("exportcustomer_product")
          .update(updates)
          .eq("id", product.id);

        if (updateError) {
          console.error(
            `[Customer Price Recalc] Error on product ${product.id}:`,
            updateError,
          );
          errors++;
        } else {
          updated++;
        }
      } catch (err) {
        console.error(
          `[Customer Price Recalc] Exception on product ${product.id}:`,
          err,
        );
        errors++;
      }
    }

    console.log(
      `[Customer Price Recalc] Done — ${updated} updated, ${errors} errors`,
    );
    return { updated, errors };
  } catch (err) {
    console.error("[Customer Price Recalc] Fatal error:", err);
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Combined trigger — runs both helpers in parallel
// ─────────────────────────────────────────────────────────────────────────────
const onRateChanged = async (newUsdRate) => {
  const [variantResult, customerResult] = await Promise.allSettled([
    updateVariantUsdRates(newUsdRate),
    recalculateCustomerPrices(newUsdRate),
  ]);

  return {
    variantUpdates:
      variantResult.status === "fulfilled"
        ? variantResult.value
        : { error: variantResult.reason?.message },
    customerPriceUpdates:
      customerResult.status === "fulfilled"
        ? customerResult.value
        : { error: customerResult.reason?.message },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate  — current rate (used by all product forms on load)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { data: currentRate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ message: "No USD rate found" });
      }
      throw error;
    }

    res.json({
      rate: currentRate.rate,
      date: currentRate.date,
      updated_at: currentRate.updated_at,
    });
  } catch (err) {
    console.error("Error fetching USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate/history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;

    const { data: history, error } = await supabase
      .from("usd_rates")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(history);
  } catch (err) {
    console.error("Error fetching USD rate history:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usd-rate/date/:date
// ─────────────────────────────────────────────────────────────────────────────
router.get("/date/:date", async (req, res) => {
  try {
    const { date } = req.params;

    const { data: rate, error } = await supabase
      .from("usd_rates")
      .select("*")
      .eq("date", date)
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ message: "No rate found for this date" });
      }
      throw error;
    }
    res.json(rate);
  } catch (err) {
    console.error("Error fetching USD rate by date:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/usd-rate  — add new rate + trigger full recalculation
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { rate, date } = req.body;

    if (!rate || parseFloat(rate) <= 0) {
      return res
        .status(400)
        .json({ message: "A valid rate greater than 0 is required" });
    }

    const newRate = parseFloat(rate);

    const { data: newRateData, error: insertError } = await supabase
      .from("usd_rates")
      .insert({
        rate: newRate,
        date: date || new Date().toISOString().split("T")[0],
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const recalcResult = await onRateChanged(newRate);

    res.status(201).json({
      message: "USD rate saved — all variants and customer prices recalculated",
      rate: newRateData.rate,
      date: newRateData.date,
      updated_at: newRateData.updated_at,
      recalculation: recalcResult,
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/usd-rate/:id  — edit rate entry + recalculate if it's the latest
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rate, date } = req.body;

    if (!rate || parseFloat(rate) <= 0) {
      return res
        .status(400)
        .json({ message: "A valid rate greater than 0 is required" });
    }

    const newRate = parseFloat(rate);

    const { data: updatedRate, error: updateError } = await supabase
      .from("usd_rates")
      .update({
        rate: newRate,
        date: date,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Only recalculate if this is the most recent rate
    const { data: latestRate } = await supabase
      .from("usd_rates")
      .select("id")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    let recalcResult = {
      skipped: true,
      reason: "Not the latest rate entry — prices unchanged",
    };
    if (latestRate && String(latestRate.id) === String(id)) {
      recalcResult = await onRateChanged(newRate);
    }

    res.json({
      message: recalcResult.skipped
        ? "Rate entry updated (not the latest — prices not recalculated)"
        : "Rate updated — all variants and customer prices recalculated",
      rate: updatedRate.rate,
      date: updatedRate.date,
      updated_at: updatedRate.updated_at,
      recalculation: recalcResult,
    });
  } catch (err) {
    console.error("Error updating USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/usd-rate/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("usd_rates").delete().eq("id", id);
    if (error) throw error;
    res.json({ message: "Rate entry deleted successfully" });
  } catch (err) {
    console.error("Error deleting USD rate:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/usd-rate/recalculate  — manual trigger
// ─────────────────────────────────────────────────────────────────────────────
router.post("/recalculate", async (req, res) => {
  try {
    const { data: latestRate, error } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !latestRate) {
      return res
        .status(404)
        .json({ message: "No USD rate found to recalculate with" });
    }

    const result = await onRateChanged(parseFloat(latestRate.rate));

    res.json({
      message: "Manual recalculation complete",
      rateUsed: latestRate.rate,
      ...result,
    });
  } catch (err) {
    console.error("Error in manual recalculation:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

export default router;
