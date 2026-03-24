import express from "express";
import supabase from "../db.js";
import multer from "multer";
import { extname } from "path";

const router = express.Router();

// Configure multer for memory storage (we'll upload to Supabase Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// GET all products with their variants
router.get("/", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("exportproductsair")
      .select("*")
      .order("common_name");

    if (error) throw error;

    const sortedProducts = products
      .map((product) => {
        if (!product.variants || !Array.isArray(product.variants)) {
          product.variants = [];
        }
        product.variants.sort((a, b) => {
          return (
            parseFloat(a.purchasing_price) - parseFloat(b.purchasing_price)
          );
        });
        return product;
      })
      .sort((a, b) => {
        const priceA =
          a.variants.length > 0
            ? Math.min(...a.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;
        const priceB =
          b.variants.length > 0
            ? Math.min(...b.variants.map((v) => parseFloat(v.purchasing_price)))
            : Infinity;
        return priceA - priceB;
      });

    res.json(sortedProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new product with variants
router.post("/upload", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    description,
    category,
    species_type,
    variants,
  } = req.body;
  let image_url = null;

  try {
    if (req.file) {
      const fileName = `${Date.now()}${extname(req.file.originalname)}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      if (uploadError) throw uploadError;
      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);
      image_url = publicUrl;
    }

    let variantsData = [];
    try {
      variantsData =
        typeof variants === "string" ? JSON.parse(variants) : variants || [];
      if (!Array.isArray(variantsData)) variantsData = [];
    } catch {
      variantsData = [];
    }

    const { data, error } = await supabase
      .from("exportproductsair")
      .insert({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        variants: variantsData,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT - Update product with variants
router.put("/upload/:id", upload.single("image"), async (req, res) => {
  const {
    common_name,
    scientific_name,
    description,
    category,
    species_type,
    existing_image_url,
    variants,
  } = req.body;
  let image_url = existing_image_url;

  try {
    const { data: currentProduct, error: fetchError } = await supabase
      .from("exportproductsair")
      .select("variants, image_url")
      .eq("id", req.params.id)
      .single();

    if (fetchError) throw fetchError;

    const oldImageUrl = currentProduct.image_url;

    if (req.file) {
      const fileName = `${Date.now()}${extname(req.file.originalname)}`;
      await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      const {
        data: { publicUrl },
      } = supabase.storage.from("product-images").getPublicUrl(fileName);
      image_url = publicUrl;
    }

    let variantsData = [];
    try {
      variantsData =
        typeof variants === "string" ? JSON.parse(variants) : variants || [];
      if (!Array.isArray(variantsData)) variantsData = [];
    } catch {
      variantsData = [];
    }

    const { error: updateError } = await supabase
      .from("exportproductsair")
      .update({
        common_name,
        scientific_name,
        description,
        category,
        species_type,
        image_url,
        variants: variantsData,
      })
      .eq("id", req.params.id);

    if (updateError) throw updateError;

    if (oldImageUrl !== image_url) {
      await updateExportCustomerImageForProduct(req.params.id, image_url);
    }

    if (currentProduct?.variants && Array.isArray(currentProduct.variants)) {
      const oldVariants = currentProduct.variants;
      for (const newVariant of variantsData) {
        const oldVariant = oldVariants.find((v) => v.id === newVariant.id);
        if (oldVariant) {
          const purchasePriceChanged =
            oldVariant.purchasing_price !== newVariant.purchasing_price;
          const exFactoryPriceChanged =
            oldVariant.exfactoryprice !== newVariant.exfactoryprice;
          if (purchasePriceChanged || exFactoryPriceChanged) {
            await updateExportCustomerPricesForVariant(
              req.params.id,
              newVariant.id,
              newVariant.exfactoryprice,
              oldVariant.exfactoryprice,
              newVariant.purchasing_price,
              oldVariant.purchasing_price,
            );
          }
        }
      }
    }

    const { data } = await supabase
      .from("exportproductsair")
      .select("*")
      .eq("id", req.params.id)
      .single();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET single product by ID
router.get("/:id", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("exportproductsair")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) {
      if (error.code === "PGRST116")
        return res.status(404).json({ error: "Product not found" });
      throw error;
    }

    if (!product.variants || !Array.isArray(product.variants))
      product.variants = [];
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("exportproductsair")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Product deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// GET all variants for a product
router.get("/:productId/variants", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("exportproductsair")
      .select("variants")
      .eq("id", req.params.productId)
      .single();
    if (error) throw error;
    res.json(product.variants || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// POST - Add new variant to a product
router.post("/:productId/variants", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    jc_fob,
    usdrate,
    labour_overhead,
    packing_cost,
    profit,
    profit_usd,
    profit_margin,
    exfactoryprice,
    multiplier,
    divisor,
  } = req.body;
  const { productId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("exportproductsair")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fetchError) throw fetchError;

    const currentVariants =
      product.variants && Array.isArray(product.variants)
        ? product.variants
        : [];

    const newVariant = {
      id: Date.now(),
      size,
      unit,
      purchasing_price: parseFloat(purchasing_price) || 0,
      jc_fob: parseFloat(jc_fob) || 0,
      usdrate: parseFloat(usdrate),
      labour_overhead: parseFloat(labour_overhead) || 0,
      packing_cost: parseFloat(packing_cost) || 0,
      profit: parseFloat(profit) || 0,
      profit_usd: parseFloat(profit_usd) || 0,
      profit_margin: parseFloat(profit_margin) || 0,
      exfactoryprice: parseFloat(exfactoryprice) || 0,
      multiplier: parseFloat(multiplier) || 0,
      divisor: parseFloat(divisor) || 1,
    };

    const updatedVariants = [...currentVariants, newVariant];
    const { error: updateError } = await supabase
      .from("exportproductsair")
      .update({ variants: updatedVariants })
      .eq("id", productId);
    if (updateError) throw updateError;

    res.status(201).json(newVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// PUT - Update a specific variant
router.put("/:productId/variants/:variantId", async (req, res) => {
  const {
    size,
    unit,
    purchasing_price,
    jc_fob,
    usdrate,
    labour_overhead,
    packing_cost,
    profit,
    profit_usd,
    profit_margin,
    exfactoryprice,
    multiplier,
    divisor,
  } = req.body;
  const { productId, variantId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("exportproductsair")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fetchError) throw fetchError;

    const currentVariants =
      product.variants && Array.isArray(product.variants)
        ? product.variants
        : [];

    const oldVariant = currentVariants.find((v) => v.id == variantId);
    const oldExFactoryPrice = oldVariant?.exfactoryprice;
    const oldPurchasePrice = oldVariant?.purchasing_price;
    const oldProfitUsd = oldVariant?.profit_usd;

    const updatedVariants = currentVariants.map((v) =>
      v.id == variantId
        ? {
            ...v,
            size,
            unit,
            purchasing_price: parseFloat(purchasing_price) || 0,
            jc_fob: parseFloat(jc_fob) || 0,
            usdrate: parseFloat(usdrate),
            labour_overhead: parseFloat(labour_overhead) || 0,
            packing_cost: parseFloat(packing_cost) || 0,
            profit: parseFloat(profit) || 0,
            profit_usd: parseFloat(profit_usd) || 0,
            profit_margin: parseFloat(profit_margin) || 0,
            exfactoryprice: parseFloat(exfactoryprice) || 0,
            multiplier: parseFloat(multiplier) || 0,
            divisor: parseFloat(divisor) || 1,
          }
        : v,
    );

    const { error: updateError } = await supabase
      .from("exportproductsair")
      .update({ variants: updatedVariants })
      .eq("id", productId);
    if (updateError) throw updateError;

    // ✅ Always recalculate customer CNF prices on any variant save.
    // Avoid fragile float comparisons (JSONB vs parsed string precision issues).
    const newExFactoryPrice = parseFloat(exfactoryprice) || 0;
    const newPurchasePriceF = parseFloat(purchasing_price) || 0;

    console.log(`[variant PUT] productId=${productId} variantId=${variantId}`);
    console.log(
      `  old exfactory=${oldExFactoryPrice}  new exfactory=${newExFactoryPrice}`,
    );
    console.log(
      `  old profit_usd=${oldProfitUsd}  new profit_usd=${parseFloat(profit_usd) || 0}`,
    );
    console.log(`  → always triggering customer CNF recalculation`);

    await updateExportCustomerPricesForVariant(
      productId,
      variantId,
      newExFactoryPrice,
      oldExFactoryPrice,
      newPurchasePriceF,
      oldPurchasePrice,
    );

    const updatedVariant = updatedVariants.find((v) => v.id == variantId);
    res.json(updatedVariant);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// DELETE - Remove a specific variant
router.delete("/:productId/variants/:variantId", async (req, res) => {
  const { productId, variantId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("exportproductsair")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fetchError) throw fetchError;

    const currentVariants =
      product.variants && Array.isArray(product.variants)
        ? product.variants
        : [];
    const updatedVariants = currentVariants.filter((v) => v.id != variantId);

    const { error: updateError } = await supabase
      .from("exportproductsair")
      .update({ variants: updatedVariants })
      .eq("id", productId);
    if (updateError) throw updateError;

    res.json({ message: "Variant deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// ============== HELPER FUNCTIONS ==============

async function updateExportCustomerImageForProduct(productId, newImageUrl) {
  try {
    console.log("Updating customer images for product:", {
      productId,
      newImageUrl,
    });

    const { data: customerPrices, error: fetchPricesError } = await supabase
      .from("exportcustomer_productair")
      .select("*")
      .eq("product_id", productId);

    if (fetchPricesError) {
      console.error("Error fetching export customer prices:", fetchPricesError);
      return;
    }
    if (!customerPrices || customerPrices.length === 0) return;

    for (const customerPrice of customerPrices) {
      const { error: updatePriceError } = await supabase
        .from("exportcustomer_productair")
        .update({ image_url: newImageUrl })
        .eq("id", customerPrice.id);

      if (updatePriceError)
        console.error(
          "Error updating export customer image:",
          updatePriceError,
        );
      else
        console.log(
          "Successfully updated image for customer price:",
          customerPrice.id,
        );
    }
  } catch (err) {
    console.error("Error in updateExportCustomerImageForProduct:", err);
  }
}

async function updateExportCustomerPricesForVariant(
  productId,
  variantId,
  newExFactoryPrice,
  oldExFactoryPrice,
  newPurchasePrice,
  oldPurchasePrice,
) {
  try {
    const { data: customerPrices, error: fetchPricesError } = await supabase
      .from("exportcustomer_productair")
      .select("*")
      .eq("product_id", productId)
      .eq("variant_id", variantId);

    if (fetchPricesError) {
      console.error("Error fetching export customer prices:", fetchPricesError);
      return;
    }

    console.log(
      `[updateCustomerPrices] found ${customerPrices?.length ?? 0} rows for product=${productId} variant=${variantId}`,
    );

    if (!customerPrices || customerPrices.length === 0) {
      console.log("No customer prices found to update");
      return;
    }

    // Get current USD rate once
    const { data: usdRateData } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("date", { ascending: false })
      .limit(1)
      .single();

    const usdRate = parseFloat(usdRateData?.rate) || 304;
    console.log(`[recalculate] using usd_rate table: ${usdRate}`);

    for (const cp of customerPrices) {
      // Log the customer price details for debugging
      console.log(`Processing customer price ${cp.id}:`, {
        freight_type: cp.freight_type,
        current_fob: cp.fob_price,
        current_cnf_45: cp.cnf_45kg,
        current_cnf_100: cp.cnf_100kg,
        multiplier: cp.multiplier,
        divisor: cp.divisor,
      });

      // Recalculate FOB using new ex-factory price + stored additional costs (in USD)
      const totalAdditionalUSD =
        (parseFloat(cp.export_doc) || 0) +
        (parseFloat(cp.transport_cost) || 0) +
        (parseFloat(cp.loading_cost) || 0) +
        (parseFloat(cp.airway_cost) || 0) +
        (parseFloat(cp.forwardHandling_cost) || 0);

      const fobInUSD = newExFactoryPrice / usdRate + totalAdditionalUSD;

      const updateData = {
        purchasing_price: newPurchasePrice,
        exfactoryprice: newExFactoryPrice,
        fob_price: fobInUSD, // ← now USD
      };

      // Handle freight calculations based on type
      if (cp.freight_type === "air") {
        console.log(`Processing AIR freight for customer ${cp.id}`);

        const m = parseFloat(cp.multiplier) || 0;
        const d = parseFloat(cp.divisor) || 1;

        // Store existing freight costs
        const existingFreight45 = parseFloat(cp.freight_cost_45kg) || 0;
        const existingFreight100 = parseFloat(cp.freight_cost_100kg) || 0;
        const existingFreight300 = parseFloat(cp.freight_cost_300kg) || 0;
        const existingFreight500 = parseFloat(cp.freight_cost_500kg) || 0;

        // Fetch the customer's air freight rate
        const { data: customerData } = await supabase
          .from("exportcustomersair")
          .select("country, airport_code")
          .eq("cus_id", cp.cus_id)
          .single();

        if (customerData) {
          console.log(`Customer data:`, customerData);

          let airRateQuery = supabase
            .from("freight_rates")
            .select("*")
            .eq("country", customerData.country)
            .order("date", { ascending: false })
            .limit(1);

          if (customerData.airport_code) {
            airRateQuery = supabase
              .from("freight_rates")
              .select("*")
              .eq("country", customerData.country)
              .eq("airport_code", customerData.airport_code)
              .order("date", { ascending: false })
              .limit(1);
          }

          const { data: airRates } = await airRateQuery;
          const airRate = airRates?.[0];

          if (airRate) {
            // Recalculate all freight costs + CNF from scratch
            const fc45 = (m * parseFloat(airRate.rate_45kg)) / d;
            const fc100 = (m * parseFloat(airRate.rate_100kg)) / d;
            const fc300 = (m * parseFloat(airRate.rate_300kg)) / d;
            const fc500 = (m * parseFloat(airRate.rate_500kg)) / d;

            console.log(`Recalculated freight costs:`, {
              fc45,
              fc100,
              fc300,
              fc500,
            });

            updateData.freight_cost_45kg = fc45;
            updateData.freight_cost_100kg = fc100;
            updateData.freight_cost_300kg = fc300;
            updateData.freight_cost_500kg = fc500;

            // CNF = FOB (USD) + Freight Cost (USD)
            updateData.cnf_45kg = fobInUSD + fc45;
            updateData.cnf_100kg = fobInUSD + fc100;
            updateData.cnf_300kg = fobInUSD + fc300;
            updateData.cnf_500kg = fobInUSD + fc500;
          } else {
            // Use existing freight costs, just update CNF with new FOB
            console.log(`Using existing freight costs:`, {
              fc45: existingFreight45,
              fc100: existingFreight100,
              fc300: existingFreight300,
              fc500: existingFreight500,
            });

            // Preserve existing freight costs
            updateData.freight_cost_45kg = existingFreight45;
            updateData.freight_cost_100kg = existingFreight100;
            updateData.freight_cost_300kg = existingFreight300;
            updateData.freight_cost_500kg = existingFreight500;

            // CNF = FOB (USD) + Existing Freight Cost (USD)
            updateData.cnf_45kg = fobInUSD + existingFreight45;
            updateData.cnf_100kg = fobInUSD + existingFreight100;
            updateData.cnf_300kg = fobInUSD + existingFreight300;
            updateData.cnf_500kg = fobInUSD + existingFreight500;

            console.log(`CNF updated with existing freight:`, {
              cnf45: updateData.cnf_45kg,
              cnf100: updateData.cnf_100kg,
              cnf300: updateData.cnf_300kg,
              cnf500: updateData.cnf_500kg,
            });
          }
        } else {
          // No customer data found, use existing freight costs
          console.log(`No customer data found, using existing freight costs`);

          updateData.freight_cost_45kg = existingFreight45;
          updateData.freight_cost_100kg = existingFreight100;
          updateData.freight_cost_300kg = existingFreight300;
          updateData.freight_cost_500kg = existingFreight500;

          updateData.cnf_45kg = fobInUSD + existingFreight45;
          updateData.cnf_100kg = fobInUSD + existingFreight100;
          updateData.cnf_300kg = fobInUSD + existingFreight300;
          updateData.cnf_500kg = fobInUSD + existingFreight500;
        }
      } else if (cp.freight_type === "sea") {
        console.log(`Processing SEA freight for customer ${cp.id}`);

        const existingFreight20 = parseFloat(cp.freight_cost_20ft) || 0;
        const existingFreight40 = parseFloat(cp.freight_cost_40ft) || 0;

        // Preserve existing freight costs
        updateData.freight_cost_20ft = existingFreight20;
        updateData.freight_cost_40ft = existingFreight40;

        // CNF = FOB (USD) + Freight Cost (USD)
        updateData.cnf_20ft = fobInUSD + existingFreight20;
        updateData.cnf_40ft = fobInUSD + existingFreight40;

        console.log(`SEA CNF calculated:`, {
          cnf20: updateData.cnf_20ft,
          cnf40: updateData.cnf_40ft,
        });
      } else {
        // If freight_type is not set, try to update any existing CNF fields
        console.log(
          `No freight type specified for customer ${cp.id}, checking for existing freight costs`,
        );

        // Check for air freight costs
        const existingFreight45 = parseFloat(cp.freight_cost_45kg) || 0;
        const existingFreight100 = parseFloat(cp.freight_cost_100kg) || 0;
        const existingFreight300 = parseFloat(cp.freight_cost_300kg) || 0;
        const existingFreight500 = parseFloat(cp.freight_cost_500kg) || 0;

        if (existingFreight45 > 0 || existingFreight100 > 0) {
          updateData.cnf_45kg = fobInUSD + existingFreight45;
          updateData.cnf_100kg = fobInUSD + existingFreight100;
          updateData.cnf_300kg = fobInUSD + existingFreight300;
          updateData.cnf_500kg = fobInUSD + existingFreight500;

          // Preserve freight costs
          updateData.freight_cost_45kg = existingFreight45;
          updateData.freight_cost_100kg = existingFreight100;
          updateData.freight_cost_300kg = existingFreight300;
          updateData.freight_cost_500kg = existingFreight500;
        }

        // Check for sea freight costs
        const existingFreight20 = parseFloat(cp.freight_cost_20ft) || 0;
        const existingFreight40 = parseFloat(cp.freight_cost_40ft) || 0;

        if (existingFreight20 > 0 || existingFreight40 > 0) {
          updateData.cnf_20ft = fobInUSD + existingFreight20;
          updateData.cnf_40ft = fobInUSD + existingFreight40;

          // Preserve freight costs
          updateData.freight_cost_20ft = existingFreight20;
          updateData.freight_cost_40ft = existingFreight40;
        }
      }

      console.log(
        `[updateCustomerPrices] row ${cp.id} final updateData:`,
        JSON.stringify(updateData, null, 2),
      );

      // Only update if we have data to update
      if (Object.keys(updateData).length > 3) {
        // More than just the 3 base fields
        const { error: updatePriceError } = await supabase
          .from("exportcustomer_productair")
          .update(updateData)
          .eq("id", cp.id);

        if (updatePriceError) {
          console.error(
            "Error updating export customer price:",
            updatePriceError,
          );
        } else {
          console.log(
            `✅ Successfully updated customer price row ${cp.id} — new FOB: ${fobInUSD.toFixed(4)} USD`,
          );

          // Log the CNF values that were updated
          if (updateData.cnf_45kg)
            console.log(`   CNF 45kg: ${updateData.cnf_45kg} USD`);
          if (updateData.cnf_100kg)
            console.log(`   CNF 100kg: ${updateData.cnf_100kg} USD`);
          if (updateData.cnf_300kg)
            console.log(`   CNF 300kg: ${updateData.cnf_300kg} USD`);
          if (updateData.cnf_500kg)
            console.log(`   CNF 500kg: ${updateData.cnf_500kg} USD`);
          if (updateData.cnf_20ft)
            console.log(`   CNF 20ft: ${updateData.cnf_20ft} USD`);
          if (updateData.cnf_40ft)
            console.log(`   CNF 40ft: ${updateData.cnf_40ft} USD`);
        }
      } else {
        console.log(`No CNF fields to update for customer ${cp.id}`);
      }
    }
  } catch (err) {
    console.error("Error in updateExportCustomerPricesForVariant:", err);
  }
}

export default router;
