import express from 'express'
import supabase from '../db.js'
import multer from 'multer'
import path from 'path'

const router = express.Router()

// Configure multer for memory storage (we'll upload to Supabase Storage)
const storage = multer.memoryStorage()
const upload = multer({ storage })

// GET all products with their variants
router.get('/', async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .order('common_name')

    if (error) throw error

    res.json(products)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// GET single product by ID
router.get('/:id', async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Product not found' })
      }
      throw error
    }

    res.json(product)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// POST - Add new product with variants
router.post('/upload', upload.single('image'), async (req, res) => {
  const { common_name, scientific_name, category, variants } = req.body
  let image_url = null

  try {
    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`
      const { error: uploadError } = await supabase.storage
        .from('product-images')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        })

      if (uploadError) throw uploadError

      const { data: { publicUrl } } = supabase.storage
        .from('product-images')
        .getPublicUrl(fileName)

      image_url = publicUrl
    }

    // Parse variants if it's a string
    const variantsData = typeof variants === 'string' ? JSON.parse(variants) : (variants || [])

    const { data, error } = await supabase
      .from('products')
      .insert({ 
        common_name, 
        scientific_name, 
        category, 
        image_url,
        variants: variantsData
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// PUT - Update product with variants
router.put('/upload/:id', upload.single('image'), async (req, res) => {
  const { common_name, scientific_name, category, existing_image_url, variants } = req.body
  let image_url = existing_image_url

  try {
    if (req.file) {
      const fileName = `${Date.now()}${path.extname(req.file.originalname)}`
      await supabase.storage
        .from('product-images')
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype
        })

      const { data: { publicUrl } } = supabase.storage
        .from('product-images')
        .getPublicUrl(fileName)

      image_url = publicUrl
    }

    // Parse variants if it's a string
    const variantsData = typeof variants === 'string' ? JSON.parse(variants) : (variants || [])

    const { error } = await supabase
      .from('products')
      .update({ 
        common_name, 
        scientific_name, 
        category, 
        image_url,
        variants: variantsData
      })
      .eq('id', req.params.id)

    if (error) throw error

    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('id', req.params.id)
      .single()

    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// DELETE product
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.json({ message: 'Product deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// ============== VARIANT OPERATIONS (within same product record) ==============

// GET all variants for a product
router.get('/:productId/variants', async (req, res) => {
  try {
    const { data: product, error } = await supabase
      .from('products')
      .select('variants')
      .eq('id', req.params.productId)
      .single()

    if (error) throw error

    res.json(product.variants || [])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// POST - Add new variant to a product
router.post('/:productId/variants', async (req, res) => {
  const { size, unit, purchasing_price } = req.body
  const { productId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Add new variant with unique ID
    const currentVariants = product.variants || []
    const newVariant = {
      id: Date.now(), // Simple unique ID
      size,
      unit,
      purchasing_price: parseFloat(purchasing_price)
    }
    const updatedVariants = [...currentVariants, newVariant]

    // Update product with new variants array
    const { error: updateError } = await supabase
      .from('products')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    res.status(201).json(newVariant)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// PUT - Update a specific variant
router.put('/:productId/variants/:variantId', async (req, res) => {
  const { size, unit, purchasing_price } = req.body
  const { productId, variantId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Update the specific variant
    const currentVariants = product.variants || []
    const updatedVariants = currentVariants.map(v => 
      v.id == variantId 
        ? { 
            ...v, 
            size, 
            unit, 
            purchasing_price: parseFloat(purchasing_price) 
          }
        : v
    )

    // Update product with modified variants array
    const { error: updateError } = await supabase
      .from('products')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    const updatedVariant = updatedVariants.find(v => v.id == variantId)
    res.json(updatedVariant)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

// DELETE - Remove a specific variant
router.delete('/:productId/variants/:variantId', async (req, res) => {
  const { productId, variantId } = req.params

  try {
    // Get current product
    const { data: product, error: fetchError } = await supabase
      .from('products')
      .select('variants')
      .eq('id', productId)
      .single()

    if (fetchError) throw fetchError

    // Remove the specific variant
    const currentVariants = product.variants || []
    const updatedVariants = currentVariants.filter(v => v.id != variantId)

    // Update product with filtered variants array
    const { error: updateError } = await supabase
      .from('products')
      .update({ variants: updatedVariants })
      .eq('id', productId)

    if (updateError) throw updateError

    res.json({ message: 'Variant deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error', details: err.message })
  }
})

export default router