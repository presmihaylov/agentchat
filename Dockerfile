# build
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/agentchatd ./cmd/agentchatd

# run
FROM alpine:3.20
RUN adduser -D -u 10001 agentchat
USER agentchat
COPY --from=build /out/agentchatd /usr/local/bin/agentchatd
EXPOSE 8090
ENTRYPOINT ["agentchatd"]
