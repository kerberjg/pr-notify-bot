ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine as base

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production



### Build the app
FROM base as build

# Install build dependencies
RUN npm ci --only=development
# Copy the rest of the files
COPY . .
# Build the app
RUN npm run build



### Final image
FROM base as final

# Copy the build files
COPY --from=build /app/build ./build
# Setup env variables
ENV NODE_ENV=production \
    GITHUB_TOKEN="" \
    BSKY_USERNAME="" \
    BSKY_PASSWORD="" \
    REPO_OWNER="" \
    REPO_NAME=""
# Run the app
CMD ["npm", "start"]
