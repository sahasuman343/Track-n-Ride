import requests

resp = requests.post(
    "https://api.olamaps.io/routing/v1/directions",
    params={
      "origin": "28.638555,76.965502",
      "destination": "28.539669,77.051907",
      "api_key": "54HMhKPWeiS3Q4P7A73yZvkzgI3r0OuRos1MOYe3"
    }
)
print(resp.json())