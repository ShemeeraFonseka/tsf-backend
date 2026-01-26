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

    console.log('Fetched rates sample:', rates?.[0]) // Debug log
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

// GET latest rate for a specific country and airport
router.get('/country/:country/airport/:airport_code/latest', async (req, res) => {
  try {
    const { country, airport_code } = req.params

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .eq('airport_code', airport_code.toUpperCase())
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this country and airport' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching latest rate by country and airport:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET latest rate for a specific country (any airport)
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

// POST - Create new freight rate with weight tiers and airport info
router.post('/', async (req, res) => {
  try {
    const { 
      country, 
      airport_code, 
      airport_name, 
      rate_45kg, 
      rate_100kg, 
      rate_300kg, 
      rate_500kg, 
      date 
    } = req.body

    // DEBUG: Log incoming data
    console.log('=== POST Request Data ===')
    console.log('Country:', country)
    console.log('Airport Code:', airport_code)
    console.log('Airport Name:', airport_name)
    console.log('Rates:', { rate_45kg, rate_100kg, rate_300kg, rate_500kg })
    console.log('Date:', date)
    console.log('========================')

    if (!country || !airport_code || !airport_name || 
        !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ 
        message: 'Country, airport code, airport name, and all weight tier rates are required' 
      })
    }

    // Validate all rates are positive
    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const insertData = {
      country: country.trim(),
      airport_code: airport_code.trim().toUpperCase(),
      airport_name: airport_name.trim(),
      rate_45kg: parseFloat(rate_45kg),
      rate_100kg: parseFloat(rate_100kg),
      rate_300kg: parseFloat(rate_300kg),
      rate_500kg: parseFloat(rate_500kg),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // DEBUG: Log data being inserted
    console.log('Inserting data:', insertData)

    const { data: newRate, error } = await supabase
      .from('freight_rates')
      .insert(insertData)
      .select()
      .single()

    if (error) {
      console.error('Supabase insert error:', error)
      throw error
    }

    // DEBUG: Log returned data
    console.log('Inserted record:', newRate)

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
    const { 
      country, 
      airport_code, 
      airport_name, 
      rate_45kg, 
      rate_100kg, 
      rate_300kg, 
      rate_500kg, 
      date 
    } = req.body

    // DEBUG: Log incoming data
    console.log('=== PUT Request Data ===')
    console.log('ID:', id)
    console.log('Country:', country)
    console.log('Airport Code:', airport_code)
    console.log('Airport Name:', airport_name)
    console.log('========================')

    if (!country || !airport_code || !airport_name || 
        !rate_45kg || !rate_100kg || !rate_300kg || !rate_500kg) {
      return res.status(400).json({ 
        message: 'Country, airport code, airport name, and all weight tier rates are required' 
      })
    }

    // Validate all rates are positive
    if (parseFloat(rate_45kg) <= 0 || parseFloat(rate_100kg) <= 0 || 
        parseFloat(rate_300kg) <= 0 || parseFloat(rate_500kg) <= 0) {
      return res.status(400).json({ message: 'All rates must be greater than 0' })
    }

    const updateData = {
      country: country.trim(),
      airport_code: airport_code.trim().toUpperCase(),
      airport_name: airport_name.trim(),
      rate_45kg: parseFloat(rate_45kg),
      rate_100kg: parseFloat(rate_100kg),
      rate_300kg: parseFloat(rate_300kg),
      rate_500kg: parseFloat(rate_500kg),
      date: date || new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    // DEBUG: Log data being updated
    console.log('Updating with data:', updateData)

    const { data: updatedRate, error } = await supabase
      .from('freight_rates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Supabase update error:', error)
      throw error
    }

    // DEBUG: Log returned data
    console.log('Updated record:', updatedRate)

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

// GET rate for specific date, country, and airport
router.get('/date/:date/country/:country/airport/:airport_code', async (req, res) => {
  try {
    const { date, country, airport_code } = req.params
    const searchDate = new Date(date)
    
    // Get start and end of day
    const startOfDay = new Date(searchDate.setHours(0, 0, 0, 0)).toISOString()
    const endOfDay = new Date(searchDate.setHours(23, 59, 59, 999)).toISOString()

    const { data: rate, error } = await supabase
      .from('freight_rates')
      .select('*')
      .eq('country', country)
      .eq('airport_code', airport_code.toUpperCase())
      .gte('date', startOfDay)
      .lte('date', endOfDay)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ message: 'No rate found for this date, country, and airport' })
      }
      throw error
    }

    res.json(rate)
  } catch (err) {
    console.error('Error fetching rate by date, country, and airport:', err)
    res.status(500).json({ message: 'Server error', error: err.message })
  }
})

// GET rate for specific date and country (legacy - any airport)
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