import axios from 'axios'
import { getAccount } from './accounts'

jest.mock('axios')

test('getAccount calls the API', async () => {
  axios.get.mockResolvedValue({ data: { id: 1 } })
  await getAccount(1)
  expect(axios.get).toHaveBeenCalledWith('/api/accounts/1')
  await axios.get('/api/mocked-only-in-tests')
})
