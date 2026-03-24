import express from "express";
import supabase from "../db.js";

const router = express.Router();

// Get price list for a customer
router.get("/:cus_id", async (req, res) => {
  try {
    const { cus_id } = req.params;

    const { data, error } = await supabase
      .from("exportcustomer_product")
      .select(
        `
        id,
        common_name,
        scientific_name,
        image_url,
        category,
        size_range,
        purchasing_price,
        exfactoryprice,
        export_doc,
        transport_cost,
        loading_cost,
        airway_cost,
        forwardHandling_cost,
        multiplier,
        divisor,
        freight_type,
        fob_price,
        product_id,
        freight_cost_45kg,
        freight_cost_100kg,
        freight_cost_300kg,
        freight_cost_500kg,
        cnf_45kg,
        cnf_100kg,
        cnf_300kg,
        cnf_500kg,
        freight_cost_20ft,
        cnf_20ft,
        freight_cost_40ft,
        cnf_40ft
      `,
      )
      .eq("cus_id", cus_id)
      .order("common_name");

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new custom price
router.post("/", async (req, res) => {
  try {
    const payload = req.body;

    const { data, error } = await supabase
      .from("exportcustomer_product")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update existing price
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const payload = { ...req.body };

    // Fetch current record
    const { data: current, error: fetchError } = await supabase
      .from("exportcustomer_product")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError) throw fetchError;

    // Fetch latest USD rate
    const { data: usdRateData } = await supabase
      .from("usd_rate")
      .select("rate")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const usdRate = parseFloat(usdRateData?.rate) || 304;

    // Recalculate FOB and CNF from scratch using incoming payload values
    const exf =
      parseFloat(payload.exfactoryprice ?? current.exfactoryprice) || 0;

    const exportDoc = parseFloat(payload.export_doc ?? current.export_doc) || 0;
    const transportCost =
      parseFloat(payload.transport_cost ?? current.transport_cost) || 0;
    const loadingCost =
      parseFloat(payload.loading_cost ?? current.loading_cost) || 0;
    const airwayCost =
      parseFloat(payload.airway_cost ?? current.airway_cost) || 0;
    const forwardHandling =
      parseFloat(
        payload.forwardHandling_cost ?? current.forwardHandling_cost,
      ) || 0;

    // Additional costs are stored in USD — convert to LKR for FOB
    const additionalCostsLKR =
      (exportDoc + transportCost + loadingCost + airwayCost + forwardHandling) *
      usdRate;
    const newFobLKR = exf + additionalCostsLKR;

    payload.fob_price = parseFloat(newFobLKR.toFixed(2));

    const freightType = payload.freight_type ?? current.freight_type;

    if (freightType === "air") {
      const fc45 =
        parseFloat(payload.freight_cost_45kg ?? current.freight_cost_45kg) || 0;
      const fc100 =
        parseFloat(payload.freight_cost_100kg ?? current.freight_cost_100kg) ||
        0;
      const fc300 =
        parseFloat(payload.freight_cost_300kg ?? current.freight_cost_300kg) ||
        0;
      const fc500 =
        parseFloat(payload.freight_cost_500kg ?? current.freight_cost_500kg) ||
        0;

      payload.cnf_45kg = parseFloat((newFobLKR / usdRate + fc45).toFixed(2));
      payload.cnf_100kg = parseFloat((newFobLKR / usdRate + fc100).toFixed(2));
      payload.cnf_300kg = parseFloat((newFobLKR / usdRate + fc300).toFixed(2));
      payload.cnf_500kg = parseFloat((newFobLKR / usdRate + fc500).toFixed(2));
    } else if (freightType === "sea") {
      const fc20 =
        parseFloat(payload.freight_cost_20ft ?? current.freight_cost_20ft) || 0;
      const fc40 =
        parseFloat(payload.freight_cost_40ft ?? current.freight_cost_40ft) || 0;

      payload.cnf_20ft = parseFloat((newFobLKR / usdRate + fc20).toFixed(2));
      payload.cnf_40ft = parseFloat((newFobLKR / usdRate + fc40).toFixed(2));
    }

    const { data, error } = await supabase
      .from("exportcustomer_product")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete price
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("exportcustomer_product")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({ message: "Price deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk add products for a customer
router.post("/bulk/:cus_id", async (req, res) => {
  try {
    const { cus_id } = req.params;
    const { products: selectedProducts } = req.body;

    if (!selectedProducts || selectedProducts.length === 0) {
      return res.status(400).json({ error: "No products provided" });
    }

    const results = [];
    const errors = [];

    for (const item of selectedProducts) {
      // Check if this variant already exists for this customer
      const { data: existing } = await supabase
        .from("exportcustomer_product")
        .select("id")
        .eq("cus_id", cus_id)
        .eq("product_id", item.product_id)
        .eq("variant_id", item.variant_id)
        .maybeSingle();

      if (existing) {
        errors.push(
          `${item.common_name} (${item.size_range}) already exists for this customer`,
        );
        continue;
      }

      const payload = {
        cus_id: parseInt(cus_id),
        product_id: item.product_id,
        variant_id: item.variant_id,
        common_name: item.common_name,
        scientific_name: item.scientific_name || null,
        image_url: item.image_url || null,
        category: item.category,
        size_range: item.size_range,
        purchasing_price: item.purchasing_price || 0,
        exfactoryprice: item.exfactoryprice || 0,
        export_doc: 0,
        transport_cost: 0,
        loading_cost: 0,
        airway_cost: 0,
        forwardHandling_cost: 0,
        freight_type: item.freight_type || "air",
        fob_price: item.exfactoryprice || 0,
        multiplier: item.multiplier || 0,
        divisor: item.divisor || 1,
        freight_cost_45kg: item.freight_cost_45kg || 0,
        freight_cost_100kg: item.freight_cost_100kg || 0,
        freight_cost_300kg: item.freight_cost_300kg || 0,
        freight_cost_500kg: item.freight_cost_500kg || 0,
        cnf_45kg: item.cnf_45kg || 0,
        cnf_100kg: item.cnf_100kg || 0,
        cnf_300kg: item.cnf_300kg || 0,
        cnf_500kg: item.cnf_500kg || 0,
        freight_cost_20ft: item.freight_cost_20ft || 0,
        cnf_20ft: item.cnf_20ft || 0,
        freight_cost_40ft: item.freight_cost_40ft || 0,
        cnf_40ft: item.cnf_40ft || 0,
      };

      const { data, error } = await supabase
        .from("exportcustomer_product")
        .insert(payload)
        .select()
        .single();

      if (error) {
        errors.push(`${item.common_name}: ${error.message}`);
      } else {
        results.push(data);
      }
    }

    res.status(201).json({
      inserted: results.length,
      skipped: errors.length,
      errors,
      data: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ONE-TIME FIX — remove after use
router.post("/fix-cnf", async (req, res) => {
  try {
    const { data: rows, error: fetchError } = await supabase
      .from("exportcustomer_product")
      .select("*")
      .eq("freight_type", "sea");

    if (fetchError) throw fetchError;

    const { data: usdRateData } = await supabase
      .from("usd_rate")
      .select("rate")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const usdRate = parseFloat(usdRateData?.rate) || 304;

    const results = [];
    for (const row of rows) {
      const exf = parseFloat(row.exfactoryprice) || 0;
      const expDoc = parseFloat(row.export_doc) || 0;
      const trans = parseFloat(row.transport_cost) || 0;
      const load = parseFloat(row.loading_cost) || 0;
      const air = parseFloat(row.airway_cost) || 0;
      const fwd = parseFloat(row.forwardHandling_cost) || 0;

      const fobLKR = exf + (expDoc + trans + load + air + fwd) * usdRate;
      const fc20 = parseFloat(row.freight_cost_20ft) || 0;
      const fc40 = parseFloat(row.freight_cost_40ft) || 0;
      const cnf20 = parseFloat((fobLKR / usdRate + fc20).toFixed(2));
      const cnf40 = parseFloat((fobLKR / usdRate + fc40).toFixed(2));

      const { error: updateError } = await supabase
        .from("exportcustomer_product")
        .update({
          fob_price: parseFloat(fobLKR.toFixed(2)),
          cnf_20ft: cnf20,
          cnf_40ft: cnf40,
        })
        .eq("id", row.id);

      results.push({
        id: row.id,
        common_name: row.common_name,
        exf,
        fobLKR: fobLKR.toFixed(2),
        cnf20,
        cnf40,
        error: updateError?.message || null,
      });
    }

    res.json({ fixed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
