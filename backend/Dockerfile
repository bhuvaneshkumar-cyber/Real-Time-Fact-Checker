# Use the official Python image from the Docker Hub
FROM python:3.12-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file
COPY requirements.txt .

# Install any dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 8001

# Define environment variables (can be overridden at runtime)
ENV HOST=0.0.0.0
ENV PORT=8001

# Run the application using Uvicorn
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8001}