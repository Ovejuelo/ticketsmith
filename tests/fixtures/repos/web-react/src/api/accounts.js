import axios from 'axios'

export const getAccount = (id) => axios.get(`/api/accounts/${id}`)

export const deactivateAccount = (id) => axios.post(`/api/accounts/${id}/deactivate`)
