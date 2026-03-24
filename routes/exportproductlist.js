import express from "express";
import supabase from "../db.js";
import multer from "multer";
import { extname } from "path";

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({ storage });

// GET all products with their variants
router.get("/", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("exportproducts")
      .select("*")
      .order("common_name");

    if (error) throw error;

    const sortedProducts = products
      .map((product) => {
        if (!product.variants || !Array.isArray(product.variants)) {
          product.variants = [];
        }
        product.variants.sort(
          (a, b) =>
            parseFloat(a.purchasing_price) - parseFloat(b.purchasing_price),
        );
        return product;
      })
      .sort((a, b) => {
        const priceA =
          a.variants.length > 0
            ? Math.min(
                ...a.variants.map(
                  (v) => parseFloat(v.purchasing_price) || Infinity,
                ),
              )
            : Infinity;
        const priceB =
          b.variants.length > 0
            ? Math.min(
                ...b.variants.map(
                  (v) => parseFloat(v.purchasing_price) || Infinity,
                ),
              )
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
      .from("exportproducts")
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
      .from("exportproducts")
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
      .from("exportproducts")
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
      for (const newVariant of variantsData) {
        const oldVariant = currentProduct.variants.find(
          (v) => v.id === newVariant.id,
        );
        if (oldVariant) {
          const exFactoryChanged =
            Math.abs(
              (oldVariant.exfactoryprice || 0) -
                (newVariant.exfactoryprice || 0),
            ) > 0.01;
          const purchaseChanged =
            Math.abs(
              (oldVariant.purchasing_price || 0) -
                (newVariant.purchasing_price || 0),
            ) > 0.01;

          if (purchaseChanged || exFactoryChanged) {
            console.log(
              `[Cascade] Product upload: variant ${newVariant.id} changed exfactory ${oldVariant.exfactoryprice} → ${newVariant.exfactoryprice}`,
            );
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
      .from("exportproducts")
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
      .from("exportproducts")
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
      .from("exportproducts")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ message: "Product deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error", details: err.message });
  }
});

// ============== VARIANT OPERATIONS ==============

// GET all variants for a product
router.get("/:productId/variants", async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from("exportproducts")
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

// POST - Add new variant
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
    multiplier,
    divisor,
  } = req.body;
  const { productId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("exportproducts")
      .select("variants")
      .eq("id", productId)
      .single();
    if (fetchError) throw fetchError;

    const currentVariants =
      product.variants && Array.isArray(product.variants)
        ? product.variants
        : [];

    const usdRateVal = parseFloat(usdrate) || 304;
    let newVariant = {};
    let calculatedExFactory = 0;

    const hasPurchasePrice = parseFloat(purchasing_price) > 0;
    const hasJCFOB = parseFloat(jc_fob) > 0;

    if (hasPurchasePrice) {
      // Model 1: Purchase Price based
      const purchasePrice = parseFloat(purchasing_price) || 0;
      const packingVal = parseFloat(packing_cost) || 0;
      const labourVal = parseFloat(labour_overhead) || 0;
      const profitVal = parseFloat(profit) || 0;

      const totalUSD = packingVal + labourVal + profitVal;
      const totalLKRCosts = totalUSD * usdRateVal;
      calculatedExFactory = purchasePrice + totalLKRCosts;
      const fobUSD = calculatedExFactory / usdRateVal;
      const calculatedProfitMargin =
        fobUSD > 0 ? parseFloat(((profitVal / fobUSD) * 100).toFixed(2)) : 0;

      newVariant = {
        id: Date.now(),
        size,
        unit,
        purchasing_price: purchasePrice,
        jc_fob: 0,
        usdrate: usdRateVal,
        labour_overhead: labourVal,
        packing_cost: packingVal,
        profit: profitVal,
        profit_margin: calculatedProfitMargin,
        exfactoryprice: calculatedExFactory,
        multiplier: parseFloat(multiplier) || 0,
        divisor: parseFloat(divisor) || 1,
      };
    } else if (hasJCFOB) {
      // Model 2: JC FOB based
      const jcFobVal = parseFloat(jc_fob) || 0;
      const profitVal = parseFloat(profit) || 0;
      const packingVal = parseFloat(packing_cost) || 0;
      const labourVal = parseFloat(labour_overhead) || 0;

      const totalUSD = jcFobVal + profitVal + packingVal + labourVal;
      calculatedExFactory = totalUSD * usdRateVal;
      const fobUSD = totalUSD;
      const calculatedProfitMargin =
        fobUSD > 0 ? parseFloat(((profitVal / fobUSD) * 100).toFixed(2)) : 0;

      newVariant = {
        id: Date.now(),
        size,
        unit,
        purchasing_price: 0,
        jc_fob: jcFobVal,
        usdrate: usdRateVal,
        labour_overhead: labourVal,
        packing_cost: packingVal,
        profit: profitVal,
        profit_margin: calculatedProfitMargin,
        exfactoryprice: calculatedExFactory,
        multiplier: parseFloat(multiplier) || 0,
        divisor: parseFloat(divisor) || 1,
      };
    } else {
      return res
        .status(400)
        .json({ error: "Either Purchase Price or JC FOB must be provided" });
    }

    const updatedVariants = [...currentVariants, newVariant];
    const { error: updateError } = await supabase
      .from("exportproducts")
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
    multiplier,
    divisor,
  } = req.body;
  const { productId, variantId } = req.params;

  try {
    const { data: product, error: fetchError } = await supabase
      .from("exportproducts")
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

    const usdRateVal = parseFloat(usdrate) || 304;
    let calculatedExFactory = 0;
    let fobUSD = 0;
    let calculatedProfitMargin = 0;
    let newPurchasePrice = 0;
    let newJcFob = 0;

    // Determine which pricing model is being used
    const hasPurchasePrice = parseFloat(purchasing_price) > 0;
    const hasJCFOB = parseFloat(jc_fob) > 0;

    if (hasPurchasePrice) {
      // Model 1: Purchase Price based
      newPurchasePrice = parseFloat(purchasing_price) || 0;
      const packingVal = parseFloat(packing_cost) || 0;
      const labourVal = parseFloat(labour_overhead) || 0;
      const profitVal = parseFloat(profit) || 0;

      // Total USD costs (packing, labour, profit)
      const totalUSD = packingVal + labourVal + profitVal;
      const totalLKRCosts = totalUSD * usdRateVal;

      // Ex-factory = Purchase Price + all costs in LKR
      calculatedExFactory = newPurchasePrice + totalLKRCosts;

      // FOB USD = (Ex-factory LKR / USD Rate)
      fobUSD = calculatedExFactory / usdRateVal;

      // Profit margin calculation based on FOB
      calculatedProfitMargin =
        fobUSD > 0 ? parseFloat(((profitVal / fobUSD) * 100).toFixed(2)) : 0;

      console.log(`[Model: Purchase Price]`, {
        purchasePrice: newPurchasePrice,
        totalUSD,
        totalLKRCosts,
        calculatedExFactory,
        fobUSD,
      });

      const updatedVariants = currentVariants.map((v) =>
        v.id == variantId
          ? {
              ...v,
              size,
              unit,
              purchasing_price: newPurchasePrice,
              jc_fob: 0, // Clear JC FOB
              usdrate: usdRateVal,
              labour_overhead: labourVal,
              packing_cost: packingVal,
              profit: profitVal,
              profit_margin: calculatedProfitMargin,
              exfactoryprice: calculatedExFactory,
              multiplier: parseFloat(multiplier) || 0,
              divisor: parseFloat(divisor) || 1,
            }
          : v,
      );

      const { error: updateError } = await supabase
        .from("exportproducts")
        .update({ variants: updatedVariants })
        .eq("id", productId);
      if (updateError) throw updateError;

      // Check if exfactory or purchase price changed
      const exFactoryChanged =
        Math.abs((oldExFactoryPrice || 0) - calculatedExFactory) > 0.01;
      const purchasePriceChanged =
        Math.abs((oldPurchasePrice || 0) - newPurchasePrice) > 0.01;

      if (exFactoryChanged || purchasePriceChanged) {
        console.log(
          `[Cascade] Purchase model - changes detected: exfactory=${exFactoryChanged}, purchase=${purchasePriceChanged}`,
        );
        await updateExportCustomerPricesForVariant(
          productId,
          variantId,
          calculatedExFactory,
          oldExFactoryPrice,
          newPurchasePrice,
          oldPurchasePrice,
        );
      }
    } else if (hasJCFOB) {
      // Model 2: JC FOB based
      newJcFob = parseFloat(jc_fob) || 0;
      const profitVal = parseFloat(profit) || 0;
      const packingVal = parseFloat(packing_cost) || 0;
      const labourVal = parseFloat(labour_overhead) || 0;

      // Total USD (JC FOB + costs)
      const totalUSD = newJcFob + profitVal + packingVal + labourVal;
      // Ex-factory = Total USD * USD Rate
      calculatedExFactory = totalUSD * usdRateVal;

      // FOB USD = JC FOB + profit + packing + labour
      fobUSD = totalUSD;

      // Profit margin calculation
      calculatedProfitMargin =
        fobUSD > 0 ? parseFloat(((profitVal / fobUSD) * 100).toFixed(2)) : 0;

      console.log(`[Model: JC FOB]`, {
        jcFob: newJcFob,
        profitVal,
        packingVal,
        labourVal,
        totalUSD,
        calculatedExFactory,
        fobUSD,
      });

      const updatedVariants = currentVariants.map((v) =>
        v.id == variantId
          ? {
              ...v,
              size,
              unit,
              purchasing_price: 0, // Clear purchase price
              jc_fob: newJcFob,
              usdrate: usdRateVal,
              labour_overhead: labourVal,
              packing_cost: packingVal,
              profit: profitVal,
              profit_margin: calculatedProfitMargin,
              exfactoryprice: calculatedExFactory,
              multiplier: parseFloat(multiplier) || 0,
              divisor: parseFloat(divisor) || 1,
            }
          : v,
      );

      const { error: updateError } = await supabase
        .from("exportproducts")
        .update({ variants: updatedVariants })
        .eq("id", productId);
      if (updateError) throw updateError;

      // Check if exfactory changed
      const exFactoryChanged =
        Math.abs((oldExFactoryPrice || 0) - calculatedExFactory) > 0.01;
      if (exFactoryChanged) {
        console.log(
          `[Cascade] JC FOB model - exfactory changed: ${oldExFactoryPrice} → ${calculatedExFactory}`,
        );
        await updateExportCustomerPricesForVariant(
          productId,
          variantId,
          calculatedExFactory,
          oldExFactoryPrice,
          0, // No purchase price
          oldPurchasePrice,
        );
      }
    } else {
      // No pricing model selected
      console.log(
        `[Warning] No pricing model selected for variant ${variantId}`,
      );
      return res
        .status(400)
        .json({ error: "Either Purchase Price or JC FOB must be provided" });
    }

    const updatedVariant = (
      await supabase
        .from("exportproducts")
        .select("variants")
        .eq("id", productId)
        .single()
    ).data.variants.find((v) => v.id == variantId);

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
      .from("exportproducts")
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
      .from("exportproducts")
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

async function updateExportCustomerPricesForVariant(
  productId,
  variantId,
  newExFactoryPrice,
  oldExFactoryPrice,
  newPurchasePrice,
  oldPurchasePrice,
) {
  try {
    console.log(
      `[Cascade] Looking for product_id=${productId} variant_id=${variantId}`,
    );
    console.log(
      `[Cascade] New values - exfactory: ${newExFactoryPrice}, purchase: ${newPurchasePrice}`,
    );

    // Fetch all customer prices for this product
    const { data: allProductPrices, error: fetchPricesError } = await supabase
      .from("exportcustomer_product")
      .select("*")
      .eq("product_id", productId);

    if (fetchPricesError) {
      console.error("Error fetching export customer prices:", fetchPricesError);
      return;
    }

    // Filter by variant_id with loose equality
    const customerPrices = (allProductPrices || []).filter(
      (cp) => String(cp.variant_id) === String(variantId),
    );

    console.log(`[Cascade] Found ${customerPrices.length} customer price rows`);

    if (customerPrices.length === 0) return;

    // Get latest USD rate
    const { data: usdRateData } = await supabase
      .from("usd_rates")
      .select("rate")
      .order("date", { ascending: false })
      .limit(1)
      .single();

    const usdRate = parseFloat(usdRateData?.rate) || 304;
    console.log(`[recalculate] using usd_rate table: ${usdRate}`);

    for (const cp of customerPrices) {
      // Calculate additional costs in USD
      const exportDoc = parseFloat(cp.export_doc) || 0;
      const transportCost = parseFloat(cp.transport_cost) || 0;
      const loadingCost = parseFloat(cp.loading_cost) || 0;
      const airwayCost = parseFloat(cp.airway_cost) || 0;
      const forwardHandling = parseFloat(cp.forwardHandling_cost) || 0;

      const totalAdditionalUSD =
        exportDoc + transportCost + loadingCost + airwayCost + forwardHandling;
      const additionalCostsLKR = totalAdditionalUSD * usdRate;

      // Recalculate FOB in LKR
      const newFobLKR = newExFactoryPrice + additionalCostsLKR;
      const fobInUSD = newFobLKR / usdRate;

      console.log(
        `[Cascade] Customer ${cp.id}: exfactory=${newExFactoryPrice}, additionalUSD=${totalAdditionalUSD}, FOB LKR=${newFobLKR.toFixed(2)}, FOB USD=${fobInUSD.toFixed(4)}`,
      );

      const updateData = {
        purchasing_price: newPurchasePrice,
        exfactoryprice: parseFloat(newExFactoryPrice.toFixed(2)),
        fob_price: parseFloat(newFobLKR.toFixed(2)),
      };

      // Recalculate CNF based on freight type
      if (cp.freight_type === "air") {
        const fc45 = parseFloat(cp.freight_cost_45kg) || 0;
        const fc100 = parseFloat(cp.freight_cost_100kg) || 0;
        const fc300 = parseFloat(cp.freight_cost_300kg) || 0;
        const fc500 = parseFloat(cp.freight_cost_500kg) || 0;

        updateData.cnf_45kg = parseFloat((fobInUSD + fc45).toFixed(2));
        updateData.cnf_100kg = parseFloat((fobInUSD + fc100).toFixed(2));
        updateData.cnf_300kg = parseFloat((fobInUSD + fc300).toFixed(2));
        updateData.cnf_500kg = parseFloat((fobInUSD + fc500).toFixed(2));

        console.log(
          `[Cascade] AIR CNF: 45kg=${updateData.cnf_45kg}, 100kg=${updateData.cnf_100kg}`,
        );
      } else if (cp.freight_type === "sea") {
        const fc20 = parseFloat(cp.freight_cost_20ft) || 0;
        const fc40 = parseFloat(cp.freight_cost_40ft) || 0;

        updateData.cnf_20ft = parseFloat((fobInUSD + fc20).toFixed(2));
        updateData.cnf_40ft = parseFloat((fobInUSD + fc40).toFixed(2));

        console.log(
          `[Cascade] SEA CNF: 20ft=${updateData.cnf_20ft}, 40ft=${updateData.cnf_40ft}`,
        );
      }

      console.log(`[Cascade] Updating id=${cp.id}`, updateData);

      const { error: updatePriceError } = await supabase
        .from("exportcustomer_product")
        .update(updateData)
        .eq("id", cp.id);

      if (updatePriceError) {
        console.error(
          "Error updating export customer price:",
          updatePriceError,
        );
      } else {
        console.log(`[Cascade] ✅ Successfully updated id=${cp.id}`);
      }
    }
  } catch (err) {
    console.error("Error in updateExportCustomerPricesForVariant:", err);
  }
}

export default router;
