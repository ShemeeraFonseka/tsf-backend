import express from 'express'
import supabase from '../db.js'

const router = express.Router()

// GET all freight rates (sorted by most recent)
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100

    const { data: rates, error } = await supabase
      .from('freight_rates')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    res.json(rates)
  } catch (err) {
    console.error('Error fetching freight rates:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET freight rates for a specific country
router.get('/country/:country', async (req, res) => {
  try {
    const { country } = req.params

    const { data: rates, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .order('updated_at', { ascending: false })

    if (error) throw error

    res.json(rates)
  } catch (err) {
    console.error('Error fetching freight rates by country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET latest rate for a specific country
router.get('/country/:country/latest', async (req, res) => {
  try {
    const { country } = req.params

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this country' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching latest rate by country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// POST - Create new freight rate with weight tiers
router.post('/', async (req, res) => {
  try {
    const { country, rate_45kg, rate_100kg, rate_300kg, rate_500kg, date } = req.body

    if (!country || !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ message: 'Country and all weight tier rates are required' })
    }

    // Validate all rates are positive
    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const { data: newRate, error } = await supabase
      .from('freight_rates')
      .insert({
        country: country.trim(),
        rate_45kg: parseFloat(rate_45kg),
        rate_100kg: parseFloat(rate_100kg),
        rate_300kg: parseFloat(rate_300kg),
        rate_500kg: parseFloat(rate_500kg),
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({
      message: 'Freight rate added successfully',
      data: newRate
    })
  } catch (err) {
    console.error('Error adding freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// PUT - Update existing freight rate
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { country, rate_45kg, rate_100kg, rate_300kg, rate_500kg, date } = req.body

    if (!country || !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ message: 'Country and all weight tier rates are required' })
    }

    // Validate all rates are positive
    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const { data: updatedRate, error } = await supabase
      .from('freight_rates')
      .update({
        country: country.trim(),
        rate_45kg: parseFloat(rate_45kg),
        rate_100kg: parseFloat(rate_100kg),
        rate_300kg: parseFloat(rate_300kg),
        rate_500kg: parseFloat(rate_500kg),
        date: date || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'Freight rate updated successfully',
      data: updatedRate
    })
  } catch (err) {
    console.error('Error updating freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// DELETE - Remove freight rate
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('freight_rates')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Freight rate deleted successfully' })
  } catch (err) {
    console.error('Error deleting freight rate:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate for specific date and country
router.get('/date/:date/country/:country', async (req, res) => {
  try {
    const { date, country } = req.params
    const searchDate = new Date(date)
    
    // Get start and end of day
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .gte('date', startOfDay)
      .lte('date', endOfDay)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this date and country' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching rate by date and country:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

export default router